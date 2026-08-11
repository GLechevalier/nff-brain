import { execSync } from 'node:child_process';
import * as path from 'node:path';
import {
  bumpRecall,
  loadBrain,
  mergeBrains,
  mutateBrain,
  recallBrain,
  resolveBrainPaths,
  scoreNovelty,
  writeModelRequest,
} from '@nff-brain/core';
import { flagStr, logToBrainDir, parseArgs, parseHookPayload, readStdin, type HookPayload } from '../util.js';

// SessionStart hook: print the recalled preamble to stdout (Claude Code adds
// hook stdout to the session context). HARD FAIL-OPEN — this must never break
// or slow a session start: no LLM call, always exit 0, errors go to a log file.

export async function cmdRecall(argv: string[]): Promise<void> {
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
      logToBrainDir(paths.project, 'last-recall.log', `project brain unreadable: ${String(err)}`);
    }
    try {
      global = loadBrain(paths.global);
    } catch (err) {
      logToBrainDir(paths.project, 'last-recall.log', `global brain unreadable: ${String(err)}`);
    }
    const merged = mergeBrains(project, global);

    // SessionStart carries no task text — proxy with the workspace name plus
    // recent commit subjects. Moot for small graphs (whole-graph bypass).
    let query = flagStr(args, 'query') ?? '';
    if (!query) {
      query = path.basename(paths.workspaceRoot);
      try {
        query +=
          ' ' +
          execSync('git log --oneline -15', { cwd: paths.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString('utf8')
            .replace(/^[0-9a-f]+ /gm, '');
      } catch {
        /* not a git repo — folder name alone */
      }
    }

    // Session baseline for auto-model: score novelty (an EMPTY brain is max
    // novelty, so this runs before the empty-graph return) and drop the
    // request file. Advisory — only the VS Code extension acts on it, and only
    // when nffBrain.autoModel is enabled.
    if (isHook) {
      try {
        const nov = scoreNovelty(merged, query);
        writeModelRequest(paths.project, {
          version: 1,
          sessionId: payload.session_id,
          cwd: paths.workspaceRoot,
          model: nov.model,
          novelty: nov.novelty,
          ts: new Date().toISOString(),
          source: 'session-start',
          top: nov.top,
        });
      } catch (err) {
        logToBrainDir(paths.project, 'last-recall.log', `model request failed: ${String(err)}`);
      }
    }

    if (merged.nodes.length === 0) return;

    const result = recallBrain(merged, query);
    if (!result.preamble) return;
    process.stdout.write(result.preamble);

    // Mark recalled nodes as used, routed back to the file each node came from.
    const byaSource: Record<'project' | 'global', string[]> = { project: [], global: [] };
    for (const n of result.nodes) {
      const src = merged.sourceById.get(n.id);
      if (src) byaSource[src].push(n.id);
    }
    for (const [src, ids] of Object.entries(byaSource) as Array<['project' | 'global', string[]]>) {
      if (!ids.length) continue;
      const file = src === 'project' ? paths.project : paths.global;
      try {
        mutateBrain(file, (b) => bumpRecall(b, ids));
      } catch (err) {
        logToBrainDir(paths.project, 'last-recall.log', `bump failed for ${src}: ${String(err)}`);
      }
    }
  } catch (err) {
    if (!isHook) throw err;
    logToBrainDir(path.join(cwd, '.nff-brain', 'brain.json'), 'last-recall.log', String(err));
  }
}
