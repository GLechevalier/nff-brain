import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { isLockStale, loadBrain, modelLadder, resolveBrainPaths } from '@nff-brain/core';
import { cliVersion } from '../util.js';
import { describeHooks } from './hooks.js';

// `nff-brain doctor` — checks the pieces the hook loop depends on and prints
// where everything lives. Exit code 1 when something load-bearing is broken.

function check(label: string, ok: boolean | null, detail: string): boolean {
  const mark = ok === null ? '·' : ok ? '✓' : '✗';
  console.log(`${mark} ${label}: ${detail}`);
  return ok !== false;
}

export async function cmdDoctor(): Promise<void> {
  const paths = resolveBrainPaths(process.cwd());
  let healthy = true;

  check('nff-brain', null, `v${cliVersion()}`);
  check(
    'distill model',
    null,
    `${process.env.NFF_BRAIN_MODEL ?? 'haiku (default)'} — override via NFF_BRAIN_MODEL or --model`,
  );
  const { ladder, thresholds } = modelLadder();
  check(
    'model ladder',
    null,
    `${ladder.join(' → ')} at novelty ${thresholds.join('/')} — override via NFF_BRAIN_MODEL_LADDER / NFF_BRAIN_NOVELTY_THRESHOLDS`,
  );

  // claude CLI present (the distiller depends on it; recall does not).
  const bin = process.env.NFF_BRAIN_CLAUDE_BIN ?? 'claude';
  const probe = spawnSync(bin, ['--version'], {
    shell: process.platform === 'win32',
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const claudeOk = probe.status === 0;
  healthy = check(
    'claude CLI',
    claudeOk,
    claudeOk ? probe.stdout.trim() : `"${bin}" not runnable — distill will fail (recall still works)`,
  ) && healthy;

  // Brain files.
  for (const [label, p] of [
    ['project brain', paths.project],
    ['global brain', paths.global],
  ] as const) {
    if (!fs.existsSync(p)) {
      check(label, null, `${p} (absent — \`nff-brain init${label.startsWith('global') ? ' --global' : ''}\`)`);
      continue;
    }
    try {
      const brain = loadBrain(p)!;
      healthy = check(label, true, `${p} — ${brain.nodes.length} node(s), ${brain.edges.length} edge(s)`) && healthy;
    } catch (err) {
      healthy = check(label, false, `${p} — ${err instanceof Error ? err.message : String(err)}`) && healthy;
    }
    const stale = isLockStale(p);
    if (stale !== null) {
      healthy = check(`${label} lock`, !stale, stale ? `stale lock at ${p}.lock — safe to delete` : 'held (an operation is running)') && healthy;
    }
  }

  // Hooks.
  for (const h of describeHooks()) {
    const state =
      h.sessionStart && h.sessionEnd
        ? `recall + distill wired${h.userPromptSubmit ? ' + auto-model' : ''}`
        : h.sessionStart || h.sessionEnd
          ? `partial (SessionStart=${h.sessionStart}, SessionEnd=${h.sessionEnd})`
          : 'not installed';
    check('hooks', h.sessionStart && h.sessionEnd ? true : null, `${h.path} — ${state}`);
  }

  console.log(`\nworkspace root: ${paths.workspaceRoot}`);
  if (!healthy) process.exit(1);
}
