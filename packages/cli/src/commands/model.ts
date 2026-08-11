import { execSync } from 'node:child_process';
import * as path from 'node:path';
import {
  loadBrain,
  localSettingsPath,
  mergeBrains,
  readModelSetting,
  readModelState,
  resolveBrainPaths,
  scoreNovelty,
  writeModelSetting,
} from '@nff-brain/core';
import { flagStr, parseArgs } from '../util.js';

// `nff-brain model` — decide which tier the NEXT Claude Code session should
// launch on, and optionally write it into `.claude/settings.local.json`.
//
// Why a settings write and not `/model`: measured against Claude Code 2.1.228,
// no hook output can set the model, `terminalSequence` is allowlisted to
// notification escapes, the VS Code extension exposes no model command, and
// `claudeCode.useTerminal` defaults to FALSE — Claude runs in the native panel,
// so there is no terminal to type into at all. The `model` setting is the one
// lever that works, and it binds at session creation.
//
// Consequence, stated plainly: this steers the NEXT session. Nothing can
// retier a session that is already running.

export async function cmdModel(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cwd = process.cwd();
  const paths = resolveBrainPaths(cwd);

  const merged = mergeBrains(loadBrainSafe(paths.project), loadBrainSafe(paths.global));

  // Same context proxy recall uses at SessionStart: what this repo is, plus
  // what has been happening in it lately.
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

  const nov = scoreNovelty(merged, query);

  // Prefer what the live sessions actually converged on: the hysteresis state
  // is the settled answer, the fresh score is only a cold-start estimate.
  const sessions = Object.values(readModelState(paths.project).sessions);
  const newest = sessions.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const model = args.flags['from-score'] === true ? nov.model : (newest?.model ?? nov.model);
  const basis = args.flags['from-score'] === true || !newest ? 'context score' : 'settled session state';

  if (args.flags.json === true) {
    process.stdout.write(
      JSON.stringify({ model, basis, novelty: nov.novelty, ladder: nov.ladder, hasSignal: nov.hasSignal }, null, 2) +
        '\n',
    );
    return;
  }

  const settingsPath = localSettingsPath(paths.workspaceRoot);
  if (args.flags.write !== true) {
    console.log(`model    ${model}   (${basis}, novelty ${nov.novelty.toFixed(2)})`);
    console.log(`ladder   ${nov.ladder.join(' → ')}`);
    console.log(`current  ${readModelSetting(settingsPath) ?? '(unset — Claude Code falls back to your global setting)'}`);
    console.log(`\nnothing written — re-run with --write to apply it to the next session`);
    return;
  }

  const { previous } = writeModelSetting(settingsPath, model);
  if (previous === model) {
    console.log(`model    ${model} — already set, nothing to do`);
    return;
  }
  console.log(`model    ${previous ?? '(unset)'} → ${model}   (${basis}, novelty ${nov.novelty.toFixed(2)})`);
  console.log(`written  ${settingsPath}`);
  console.log(`\n⚠ takes effect on the NEXT session — Claude Code binds the model at session creation.`);
}

function loadBrainSafe(p: string) {
  try {
    return loadBrain(p);
  } catch {
    return null;
  }
}
