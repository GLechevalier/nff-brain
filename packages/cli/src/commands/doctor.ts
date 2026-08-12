import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  clipQueueStats,
  clipsPath,
  discoverSessions,
  embedCacheDir,
  embedModel,
  isInstanceAlive,
  isLockStale,
  loadBrain,
  loadImportState,
  loadServeConfig,
  loadVectors,
  modelLadder,
  readInstance,
  resolveBrainPaths,
  resolveTransformers,
  serveConfigMode,
  serveConfigPath,
  vectorPlan,
} from '@nff-brain/core';
import type { BrainFile } from '@nff-brain/core';
import { cliVersion } from '../util.js';
import { describeHooks } from './hooks.js';

// `nff-brain doctor` — checks the pieces the hook loop depends on and prints
// where everything lives. Exit code 1 when something load-bearing is broken.

function check(label: string, ok: boolean | null, detail: string): boolean {
  const mark = ok === null ? '·' : ok ? '✓' : '✗';
  console.log(`${mark} ${label}: ${detail}`);
  return ok !== false;
}

function semanticChecks(brains: { label: string; path: string; brain: BrainFile }[]): void {
  const rt = resolveTransformers();
  const model = embedModel();
  if (!rt.installed) {
    check(
      'semantic search',
      null,
      'off (lexical only) — `nff-brain semantic install` enables it ' +
        '(~400 MB runtime + ~33 MB model, one-time)',
    );
    return;
  }
  check(
    'semantic search',
    null,
    `runtime present — ${model} · ${rt.dir}${rt.version ? ` (v${rt.version})` : ''} · weights ${embedCacheDir()}`,
  );

  const parts: string[] = [];
  for (const b of brains) {
    const vf = loadVectors(b.path);
    if (!vf) {
      parts.push(`${b.label} none`);
      continue;
    }
    const plan = vectorPlan(b.brain, vf, model);
    const total = b.brain.nodes.length;
    const bits = [`${plan.fresh.length}/${total} current`];
    if (plan.stale.length) bits.push(`${plan.stale.length} stale`);
    if (plan.orphaned.length) bits.push(`${plan.orphaned.length} orphaned`);
    if (vf.model !== model) bits.push(`built with ${vf.model}`);
    parts.push(`${b.label} ${bits.join(', ')}`);
  }
  const anyStale = parts.some((p) => p.includes('stale') || p.includes('none') || p.includes('built with'));
  check(
    'vector index',
    null,
    `${parts.join(' · ') || 'no brain files'}${anyStale ? ' — run `nff-brain index`' : ''}`,
  );
  // `semantic status` is where you pay the model-load cost; doctor points at it
  // rather than doing it, so a broken native binary shows up there, not here.
  if (anyStale) return;
  check('semantic check', null, 'run `nff-brain semantic status` to verify the model actually loads');
}

/**
 * Reports on `nff-brain serve` and the clip queue. Never prints a token value —
 * e2eServe.test.ts asserts that, because doctor output routinely gets pasted
 * into issues.
 */
function serveChecks(): boolean {
  let ok = true;
  const inst = readInstance();
  if (!inst) {
    check('serve', null, 'not running — `nff-brain serve` (Chrome extension transport)');
  } else if (!isInstanceAlive(inst)) {
    check('serve', null, `stale record for pid ${inst.pid} (not running) — safe to ignore`);
  } else {
    const cfg = loadServeConfig();
    const clients = cfg?.clients.length ?? 0;
    check(
      'serve',
      null,
      `running — pid ${inst.pid}, port ${inst.port}, workspace ${inst.workspaceRoot}, ` +
        `${clients} client${clients === 1 ? '' : 's'} paired`,
    );
  }

  const mode = serveConfigMode();
  if (mode !== null && (mode & 0o077) !== 0) {
    ok = check(
      'serve config',
      false,
      `${serveConfigPath()} is mode ${mode.toString(8)} — it holds bearer tokens; ` +
        `run \`chmod 600 ${serveConfigPath()}\``,
    );
  }

  // Report every queue that has anything in it, whichever brain it targets.
  // Deduped by resolved path: when the workspace root IS the home directory,
  // project and global name the same file and it would otherwise print twice.
  const paths = resolveBrainPaths(process.cwd());
  const seen = new Set<string>();
  for (const [label, p] of [
    ['project', paths.project],
    ['global', paths.global],
  ] as const) {
    const file = clipsPath(p);
    if (seen.has(file)) continue;
    seen.add(file);
    const stats = clipQueueStats(p);
    if (stats.pending === 0 && !stats.full) continue;
    check(
      'clip queue',
      null,
      `${stats.pending} pending in ${file} (${label})` +
        (stats.full ? ' — FULL, captures are being refused until a session drains it' : ''),
    );
  }
  return ok;
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
  const brains: { label: string; path: string; brain: BrainFile }[] = [];
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
      brains.push({ label: label.split(' ')[0]!, path: p, brain });
      healthy = check(label, true, `${p} — ${brain.nodes.length} node(s), ${brain.edges.length} edge(s)`) && healthy;
    } catch (err) {
      healthy = check(label, false, `${p} — ${err instanceof Error ? err.message : String(err)}`) && healthy;
    }
    const stale = isLockStale(p);
    if (stale !== null) {
      healthy = check(`${label} lock`, !stale, stale ? `stale lock at ${p}.lock — safe to delete` : 'held (an operation is running)') && healthy;
    }
  }

  // Chrome extension transport (optional tier — `·`, never flips the exit
  // code). The ONE exception is a world-readable serve.json: the file existing
  // means the user opted in, so a leaked bearer token there is a real fault.
  healthy = serveChecks() && healthy;

  // Semantic search (optional tier). Always reported with the `·` marker: it is
  // optional by construction, so it must NEVER flip the exit code. And it must
  // never load the model — resolveTransformers is a path check and loadVectors
  // reads one small JSON, so doctor stays sub-second.
  semanticChecks(brains);

  // Claude Code history — the source `nff-brain import` mines. Informational
  // only (`·`): having no history is a normal state, not a fault.
  try {
    const found = discoverSessions({ cwd: paths.workspaceRoot, limit: 0 });
    const state = loadImportState(paths.project);
    const mined = Object.keys(state.sessions).length;
    if (found.sessions.length || mined) {
      check(
        'claude history',
        null,
        `${found.sessions.length} importable session(s) for this workspace in ${found.projectsDir}` +
          `${mined ? ` (${mined} already imported)` : ' — `nff-brain import` turns them into memories'}`,
      );
    } else {
      check(
        'claude history',
        null,
        `no importable sessions under ${found.projectsDir}` +
          (found.skipped.oneshot ? ` (${found.skipped.oneshot} one-shot \`claude -p\` run(s) skipped)` : '') +
          ' — set NFF_BRAIN_CLAUDE_HOME if your config lives elsewhere',
      );
    }
  } catch {
    /* history discovery is best-effort — never fail doctor over it */
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
