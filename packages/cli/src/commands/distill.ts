import * as path from 'node:path';
import {
  appendActivity,
  applyDelta,
  buildDistillPrompt,
  extractJson,
  firstUserText,
  loadBrain,
  emptyBrain,
  mutateBrain,
  pruneBrain,
  readTranscript,
  resolveBrainPaths,
  runClaude,
  type RawDelta,
} from '@nff-brain/core';
import { drainClips } from '../clipDrain.js';
import { refreshVectors } from '../semanticRefresh.js';
import { flagStr, logToBrainDir, parseArgs, parseHookPayload, readStdin } from '../util.js';

// SessionEnd hook: distill the session transcript into brain nodes. HARD
// FAIL-OPEN — one claude -p call with a 60s timeout, errors to a log file,
// always exit 0 in hook mode. The LLM call runs OUTSIDE the file lock (it can
// take a minute); only the fast applyDelta/prune runs under it.

const MAX_TOTAL_NODES = 400;
const MIN_TRANSCRIPT_CHARS = 200; // don't distill trivial/empty sessions

// "semantic is simply off" is the overwhelmingly common case — logging it every
// session would bury the failures that actually matter in last-distill.log.
const SILENT_REFRESH = new Set(['disabled', 'semantic off', 'no vector index', 'runtime absent', 'already current']);

export async function cmdDistill(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const isHook = args.flags['stdin-hook'] === true;

  if (isHook && process.env.NFF_BRAIN_SKIP === '1') return; // our own claude -p run

  let cwd = process.cwd();
  try {
    let transcriptPath = flagStr(args, 'transcript');
    let sessionId = flagStr(args, 'session') ?? null;
    if (isHook) {
      const payload = parseHookPayload(await readStdin());
      if (payload.cwd) cwd = payload.cwd;
      transcriptPath = transcriptPath ?? payload.transcript_path;
      sessionId = sessionId ?? payload.session_id ?? null;
    }
    const paths = resolveBrainPaths(cwd);
    const target = args.flags.global === true ? paths.global : paths.project;

    // Drain queued browser clips BEFORE the transcript early-returns below: a
    // browsing-only session is exactly when the queue has content and the
    // transcript is short or absent. Fail-open internally; never throws.
    const drained = await drainClips(paths, { model: flagStr(args, 'model') });
    if (drained.created.length > 0 || drained.refined.length > 0) {
      // Clip nodes can land in either brain (clips carry their own target).
      for (const brainPath of new Set([paths.global, paths.project])) {
        const vec = await refreshVectors(brainPath);
        if (vec.ran) logToBrainDir(brainPath, 'last-distill.log', `re-embedded ${vec.embedded} node(s) after clip drain`);
      }
    }

    if (!transcriptPath) {
      if (isHook) return;
      throw new Error('no transcript: pass --transcript <path> or --stdin-hook');
    }

    const transcript = readTranscript(transcriptPath);
    if (transcript.length < MIN_TRANSCRIPT_CHARS) {
      logToBrainDir(target, 'last-distill.log', `skipped: transcript too short (${transcript.length} chars)`);
      return;
    }
    const taskText = firstUserText(transcriptPath) || path.basename(paths.workspaceRoot);

    // Snapshot for the prompt (lock-free); applyDelta revalidates under the lock.
    const snapshot = loadBrain(target) ?? emptyBrain();
    const prompt = buildDistillPrompt({
      taskText,
      transcript,
      knownNodes: snapshot.nodes,
      maxNewNodes: 3,
      maxTranscriptChars: 12_000,
    });

    const raw = await runClaude(prompt, { model: flagStr(args, 'model') });
    const delta = extractJson<RawDelta>(raw);
    if (!delta) {
      logToBrainDir(target, 'last-distill.log', 'distiller returned no parseable JSON; skipping');
      return;
    }

    const { written, pruned } = mutateBrain(target, (brain) => {
      const written = applyDelta(brain, delta, { maxNewNodes: 3, sessionId });
      const pruned = pruneBrain(brain, MAX_TOTAL_NODES);
      return { written, pruned };
    });

    if (written.size > 0) {
      // Always the PROJECT activity file, even for --global distills — the
      // glow belongs to whichever workspace's graph panel is watching.
      appendActivity(paths.project, {
        kind: 'distill',
        ids: [...written],
        sessionId: sessionId ?? undefined,
      });
    }

    logToBrainDir(
      target,
      'last-distill.log',
      `distilled ${written.size} node(s) [${[...written].join(', ')}]${pruned ? `, pruned ${pruned}` : ''}`,
    );

    // New nodes ⇒ the vector sidecar is stale. No-op (microseconds) unless the
    // user has opted into semantic search; never throws. See semanticRefresh.ts
    // for the SessionEnd timeout budget.
    if (written.size > 0 || pruned > 0) {
      const vec = await refreshVectors(target);
      if (vec.ran) logToBrainDir(target, 'last-distill.log', `re-embedded ${vec.embedded} node(s)`);
      else if (vec.reason && !SILENT_REFRESH.has(vec.reason)) {
        logToBrainDir(target, 'last-distill.log', `vector refresh skipped: ${vec.reason}`);
      }
    }

    if (!isHook) {
      console.log(`distilled ${written.size} node(s): ${[...written].join(', ') || '(none)'}`);
    }
  } catch (err) {
    if (!isHook) throw err;
    logToBrainDir(path.join(cwd, '.nff-brain', 'brain.json'), 'last-distill.log', String(err));
  }
}
