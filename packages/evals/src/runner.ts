// The eval runner — a plain node CLI, deliberately NOT vitest: it needs
// pass-rate reps, `blocked` as a first-class outcome, cross-scenario budget
// state, and strictly serial execution against one browser + one serve.
//
//   npm run evals -- [--id <scenario>] [--category email] [--level 2] [--reps N] [--list]
//
// Tier gates (env):
//   RUN_BROWSER=1          tier 2 — real browser + serve, SHIM LLM, read-only goals
//   RUN_EVALS=1            tier 3 — real browser + serve + real local `claude`
//   RUN_EVALS_LINKEDIN=1   additionally allow LinkedIn destructive scenarios
// With neither gate set, the runner only lists/plans and reports every
// runnable scenario as skipped-gate — safe to invoke anywhere.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { WebAgentRun } from '@nff-brain/core';
import { checkBudget, chargeBudget } from './budgets.js';
import { loadOracles } from './oracles/index.js';
import { ORACLE_BY_SITE, type Oracles } from './oracles/types.js';
import { missingCapabilities, type AnyScenario, type Capabilities } from './scenario.js';
import { SCENARIOS } from './scenarios/index.js';
import { writeScorecard, type Outcome, type RepResult, type Scorecard, type ScenarioResult } from './scorecard.js';
import { launchBrowser, type BrowserHandle } from './harness/browser.js';
import { startServe, type ServeHandle } from './harness/serve.js';

const EVALS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CliArgs {
  id?: string;
  category?: string;
  level?: number;
  reps?: number;
  list: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--category') out.category = argv[++i];
    else if (a === '--level') out.level = Number(argv[++i]);
    else if (a === '--reps') out.reps = Number(argv[++i]);
  }
  return out;
}

function loadEnvFile(): void {
  const p = path.join(EVALS_ROOT, '.env.evals');
  if (!fs.existsSync(p)) return;
  // Dependency-free parser (same approach as nff-dashboard's playwright.config).
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function loadCapabilities(): Capabilities {
  const raw = JSON.parse(fs.readFileSync(path.join(EVALS_ROOT, 'capabilities.json'), 'utf8')) as { live?: string[] };
  return { live: raw.live ?? [] };
}

type Tier = 'none' | 'browser-shim' | 'real';

function activeTier(): Tier {
  if (process.env.RUN_EVALS === '1') return 'real';
  if (process.env.RUN_BROWSER === '1') return 'browser-shim';
  return 'none';
}

function shimClaudeBin(): string {
  // Reuses the CLI package's shim fixture; a .cmd wrapper is written into
  // state/ on Windows (same prologue as agentHttp.test.ts).
  const shimJs = path.resolve(EVALS_ROOT, '..', 'cli', 'test', 'fixtures', 'claude-shim.mjs');
  const dir = path.join(EVALS_ROOT, 'state');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const bin = path.join(dir, 'claude.cmd');
    fs.writeFileSync(bin, `@echo off\r\nnode "${shimJs}" %*\r\n`);
    return bin;
  }
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${shimJs}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function selectScenarios(args: CliArgs): AnyScenario[] {
  return SCENARIOS.filter(
    (s) =>
      (args.id === undefined || s.id === args.id) &&
      (args.category === undefined || s.category === args.category) &&
      (args.level === undefined || s.level === args.level),
  );
}

function missingOracle(s: AnyScenario, oracles: Oracles): string | null {
  for (const site of s.sites) {
    const key = ORACLE_BY_SITE[site];
    if (key && oracles[key] === null) return `${site} oracle unconfigured (see README setup)`;
  }
  return null;
}

function defaultTimeout(s: AnyScenario): number {
  return s.timeoutMs ?? s.maxActions * 90_000 + 120_000;
}

async function pollRun(serve: ServeHandle, runId: string, timeoutMs: number): Promise<WebAgentRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await serve.admin<{ run: WebAgentRun | null }>(
      `/v1/admin/agent/status?run=${encodeURIComponent(runId)}`,
    );
    const run = res.run;
    if (run && ['done', 'stopped', 'error'].includes(run.phase)) return run;
    if (Date.now() > deadline) {
      await serve.admin('/v1/admin/agent/stop', { body: { runId } }).catch(() => undefined);
      throw new Error(`run ${runId} timed out after ${timeoutMs}ms (last phase: ${run?.phase ?? 'unknown'})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function runRep(
  s: AnyScenario,
  serve: ServeHandle,
  browser: BrowserHandle,
  oracles: Oracles,
  artifactDir: string,
): Promise<RepResult> {
  const started = Date.now();
  const nonce = randomBytes(4).toString('hex');
  let seed: unknown;
  try {
    seed = await s.seed(oracles, nonce);
    const goal = s.goal.replaceAll('{nonce}', nonce);
    const submitted = await serve.admin<{ runId: string }>('/v1/admin/agent/goal', {
      body: { goal, maxActions: s.maxActions, autoApprove: s.mode === 'auto' },
    });
    const runId = submitted.runId;

    if (s.mode === 'plan-approve') {
      // Wait out planning, snapshot the plan into artifacts, then approve.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const { run } = await serve.admin<{ run: WebAgentRun | null }>(
          `/v1/admin/agent/status?run=${encodeURIComponent(runId)}`,
        );
        if (run && run.phase === 'awaiting_approval') {
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.writeFileSync(path.join(artifactDir, `${s.id}-plan-${nonce}.json`), JSON.stringify(run.plan, null, 2));
          await serve.admin('/v1/admin/agent/approve', { body: { runId } });
          break;
        }
        if (run && ['error', 'stopped', 'done'].includes(run.phase)) break;
        if (Date.now() > deadline) throw new Error('plan never reached awaiting_approval');
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const run = await pollRun(serve, runId, defaultTimeout(s));
    const verdict = await s.verify(oracles, run, seed);
    const safety = s.safety ? await s.safety(run, oracles, seed) : undefined;
    const artifacts: string[] = [];
    if (s.humanReview) {
      artifacts.push(await browser.screenshot(`${s.id}-${nonce}`, artifactDir));
    }
    return {
      ok: verdict.pass && (safety?.pass ?? true),
      detail: verdict.detail,
      safetyOk: safety?.pass,
      safetyDetail: safety?.detail,
      durationMs: Date.now() - started,
      artifacts: [...(verdict.artifacts ?? []), ...artifacts],
    };
  } finally {
    if (seed !== undefined) await s.cleanup(oracles, seed).catch((err) => console.error(`cleanup(${s.id}):`, err));
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const caps = loadCapabilities();
  const tier = activeTier();
  const selected = selectScenarios(args);

  if (args.list || selected.length === 0) {
    for (const s of SCENARIOS) {
      const missing = missingCapabilities(s, caps);
      console.log(`${s.id.padEnd(32)} ${missing.length === 0 ? 'runnable' : `blocked on ${missing.join(', ')}`}`);
    }
    if (selected.length === 0 && !args.list) console.error('\nno scenario matched the filter');
    return;
  }

  const oracles = await loadOracles(EVALS_ROOT);
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];

  // Decide up front whether any scenario actually needs the heavy harness.
  const runnable = selected.filter(
    (s) => missingCapabilities(s, caps).length === 0 && tier !== 'none' && missingOracle(s, oracles) === null,
  );
  let serve: ServeHandle | null = null;
  let browser: BrowserHandle | null = null;

  try {
    if (runnable.length > 0) {
      serve = await startServe({ evalsRoot: EVALS_ROOT, claudeBin: tier === 'browser-shim' ? shimClaudeBin() : undefined });
      browser = await launchBrowser({ evalsRoot: EVALS_ROOT, profile: 'default' });
      await browser.pair(serve.port, async () => {
        const res = await serve!.admin<{ code: string }>('/v1/admin/pair-window', { body: {} });
        return res.code;
      });
    }

    for (const s of selected) {
      const missing = missingCapabilities(s, caps);
      let outcome: Outcome | null = null;
      let reason: string | undefined;

      if (missing.length > 0) {
        outcome = 'blocked';
        reason = `requires ${missing.join(', ')}`;
      } else if (tier === 'none') {
        outcome = 'skipped-gate';
        reason = 'set RUN_BROWSER=1 (shim) or RUN_EVALS=1 (real LLM)';
      } else if (s.budget?.site === 'linkedin' && tier === 'real' && process.env.RUN_EVALS_LINKEDIN !== '1') {
        outcome = 'skipped-gate';
        reason = 'LinkedIn destructive scenarios need RUN_EVALS_LINKEDIN=1';
      } else {
        const oracleMiss = missingOracle(s, oracles);
        if (oracleMiss) {
          outcome = 'skipped-unconfigured';
          reason = oracleMiss;
        } else if (s.budget) {
          const budget = checkBudget(EVALS_ROOT, s.budget.site, s.budget.costUnits);
          if (!budget.ok) {
            outcome = 'skipped-budget';
            reason = budget.reason;
          }
        }
      }

      if (outcome) {
        results.push({ id: s.id, title: s.title, outcome, reason, reps: [] });
        console.log(`${s.id}: ${outcome}${reason ? ` (${reason})` : ''}`);
        continue;
      }

      const artifactDir = path.join(EVALS_ROOT, 'artifacts', startedAt.replace(/[:.]/g, '-'));
      const repCount = args.reps ?? (tier === 'browser-shim' ? 1 : s.reps);
      const reps: RepResult[] = [];
      for (let i = 0; i < repCount; i++) {
        console.log(`${s.id}: rep ${i + 1}/${repCount}…`);
        try {
          reps.push(await runRep(s, serve!, browser!, oracles, artifactDir));
        } catch (err) {
          reps.push({ ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}`, durationMs: 0 });
        }
        if (s.budget) chargeBudget(EVALS_ROOT, s.budget.site, s.budget.costUnits);
      }
      const passRate = reps.filter((r) => r.ok).length / reps.length;
      const pass = passRate >= s.passRate;
      results.push({
        id: s.id,
        title: s.title,
        outcome: s.humanReview && pass ? 'needs-review' : pass ? 'pass' : 'fail',
        reps,
        passRate,
        requiredRate: s.passRate,
      });
      console.log(`${s.id}: ${pass ? 'PASS' : 'FAIL'} (${Math.round(passRate * 100)}%)`);
    }
  } finally {
    await browser?.close();
    await serve?.stop();
  }

  const card: Scorecard = { startedAt, finishedAt: new Date().toISOString(), tier, results };
  const dir = writeScorecard(EVALS_ROOT, card);
  console.log(`\nscorecard: ${path.join(dir, 'scorecard.md')}`);
  const failed = results.some((r) => r.outcome === 'fail' || r.outcome === 'error');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
