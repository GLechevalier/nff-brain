import * as path from 'node:path';
import {
  appendActivity,
  loadBrain,
  mergeBrains,
  readModelRequest,
  resolveBrainPaths,
  scoreNovelty,
  writeModelRequest,
} from '@nff-brain/core';
import { flagStr, logToBrainDir, parseArgs, parseHookPayload, readStdin, type HookPayload } from '../util.js';

// `nff-brain novelty` — how new is a task relative to the brain, and which
// session model does that imply?
//
// Two faces:
//  - Interactive: explainability/debug. Prints the score, the picked model and
//    the contributing nodes; --json emits the raw NoveltyResult.
//  - `--stdin-hook` (UserPromptSubmit): re-scores against the ACTUAL prompt
//    text and updates .nff-brain/model-request.json — but only when the picked
//    model changed, so the extension doesn't retype /model every prompt.
//    SILENT on stdout (UserPromptSubmit stdout is injected into the session
//    context) and HARD FAIL-OPEN like recall: no LLM, always exit 0.

export async function cmdNovelty(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const isHook = args.flags['stdin-hook'] === true;

  if (isHook && process.env.NFF_BRAIN_SKIP === '1') return; // our own claude -p run

  let cwd = process.cwd();
  try {
    let payload: HookPayload = {};
    if (isHook) {
      payload = parseHookPayload(await readStdin());
      if (payload.cwd) cwd = payload.cwd;
    }
    const paths = resolveBrainPaths(cwd);

    let project = null;
    let global = null;
    try {
      project = loadBrain(paths.project);
    } catch (err) {
      if (!isHook) throw err;
      logToBrainDir(paths.project, 'last-recall.log', `novelty: project brain unreadable: ${String(err)}`);
    }
    try {
      global = loadBrain(paths.global);
    } catch (err) {
      if (!isHook) throw err;
      logToBrainDir(paths.project, 'last-recall.log', `novelty: global brain unreadable: ${String(err)}`);
    }
    const merged = mergeBrains(project, global);

    if (isHook) {
      const prompt = (payload.prompt ?? '').trim();
      if (!prompt || prompt.startsWith('/')) return; // nothing to judge / slash command
      const nov = scoreNovelty(merged, prompt);
      // The per-prompt heartbeat for the graph webview: which nodes this
      // prompt made the brain think of. Emitted unconditionally (BEFORE the
      // model-unchanged early return) — the glow is not an auto-model feature.
      if (nov.top.length > 0) {
        appendActivity(paths.project, {
          kind: 'prompt',
          ids: nov.top.map((t) => t.id),
          sessionId: payload.session_id,
        });
      }
      const prev = readModelRequest(paths.project);
      if (prev?.model === nov.model) return; // no change — don't retype /model
      writeModelRequest(paths.project, {
        version: 1,
        sessionId: payload.session_id,
        cwd: paths.workspaceRoot,
        model: nov.model,
        novelty: nov.novelty,
        ts: new Date().toISOString(),
        source: 'prompt',
        top: nov.top,
      });
      return;
    }

    const query = flagStr(args, 'query') ?? args.positional.join(' ');
    if (!query.trim()) {
      console.error('nff-brain: novelty needs a query — `nff-brain novelty --query "the task"`');
      process.exit(1);
    }
    const nov = scoreNovelty(merged, query);
    if (args.flags.json === true) {
      process.stdout.write(JSON.stringify(nov, null, 2) + '\n');
      return;
    }
    const cuts = nov.thresholds.map((t, i) => `<${t} → ${nov.ladder[i]}`).join(', ');
    console.log(`novelty  ${nov.novelty.toFixed(2)}  →  ${nov.model}`);
    console.log(`ladder   ${nov.ladder.join(' → ')}  (${cuts}, else ${nov.ladder[nov.ladder.length - 1]})`);
    if (nov.top.length === 0) {
      console.log('anchors  none — nothing in the brain matches this query');
    } else {
      console.log('anchors');
      for (const t of nov.top) {
        console.log(
          `  ${t.id}  relevance=${t.score.toFixed(2)} strength=${t.strength.toFixed(2)} deg=${t.degree}  ${t.title}`,
        );
      }
    }
  } catch (err) {
    if (!isHook) throw err;
    logToBrainDir(path.join(cwd, '.nff-brain', 'brain.json'), 'last-recall.log', `novelty: ${String(err)}`);
  }
}
