// The act-benchmark runner: browser-action primitives against local fixture
// pages, driven ONLY through the bench driver inside a NFF_BRAIN_BENCH=1
// extension build (never via harness-side CDP — see harness/chrome.ts).
//
//   npm run evals:act -- --list
//   RUN_BROWSER=1 npm run evals:act -- --layer engine [--family pointer] [--id …]
//   RUN_EVALS=1  npm run evals:act -- --layer agent
//
// Tiers: layer A (engine conformance) is deterministic and runs under
// RUN_BROWSER=1 or RUN_EVALS=1; layer B (agent capability) needs the real
// `claude` and runs only under RUN_EVALS=1.

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { writeScorecard, type Outcome, type RepResult, type ScenarioResult, type Scorecard } from './scorecard.js';
import { startFixtures, type FixtureHandle } from './harness/fixtures.js';
import { launchChrome, type ChromeHandle } from './harness/chrome.js';
import { DriverClient } from './harness/driver.js';
import { startServe, type ServeHandle } from './harness/serve.js';
import {
  isAgentScenario,
  missingActCapabilities,
  type ActAgentScenario,
  type ActConformanceCase,
  type AnyActCase,
  type BenchCtx,
  type Capabilities,
  type Verdict,
} from './act/actScenario.js';
import { ACT_AGENT_SCENARIOS, ACT_CASES } from './act/index.js';
import type { ActRunView } from '@nff-brain/core/benchProtocol';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Layer = 'engine' | 'agent' | 'all';

interface Args {
  list: boolean;
  layer: Layer;
  id?: string;
  family?: string;
  reps?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, layer: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') args.list = true;
    else if (a === '--layer') args.layer = argv[++i] as Layer;
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--family') args.family = argv[++i];
    else if (a === '--reps') args.reps = Number(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!['engine', 'agent', 'all'].includes(args.layer)) throw new Error(`--layer must be engine|agent|all`);
  return args;
}

type Tier = 'none' | 'browser' | 'real';

function activeTier(): Tier {
  if (process.env.RUN_EVALS === '1') return 'real';
  if (process.env.RUN_BROWSER === '1') return 'browser';
  return 'none';
}

function loadCapabilities(): Capabilities {
  return JSON.parse(fs.readFileSync(path.join(evalsRoot, 'capabilities.json'), 'utf8')) as Capabilities;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pre-flight outcome for a case, or null when it should actually run. */
function gateOutcome(c: AnyActCase, caps: Capabilities, tier: Tier): { outcome: Outcome; reason: string } | null {
  if (c.outOfScope) return { outcome: 'out-of-scope', reason: c.outOfScope };
  const missing = missingActCapabilities(c, caps);
  if (missing.length > 0) return { outcome: 'blocked', reason: `requires ${missing.join(', ')}` };
  if (isAgentScenario(c)) {
    if (tier !== 'real') return { outcome: 'skipped-gate', reason: 'set RUN_EVALS=1 (real LLM) for agent-layer scenarios' };
  } else if (tier === 'none') {
    return { outcome: 'skipped-gate', reason: 'set RUN_BROWSER=1 or RUN_EVALS=1 to run the engine layer' };
  }
  return null;
}

interface Session {
  fixtures: FixtureHandle;
  chrome: ChromeHandle;
  driver: DriverClient;
  serve: ServeHandle | null;
}

async function openSession(needServe: boolean): Promise<Session> {
  const fixtures = await startFixtures({ evalsRoot });
  let chrome: ChromeHandle;
  try {
    chrome = launchChrome({ evalsRoot, profile: 'act-bench', startUrl: `${fixtures.baseUrl}/fixtures/idle.html` });
  } catch (err) {
    // Without this, a launch failure leaks the listening fixture server and
    // the process never exits (its handle keeps the event loop alive).
    await fixtures.close();
    throw err;
  }
  const driver = new DriverClient(fixtures);
  try {
    await fixtures.waitForDriver(45_000);
    await driver.ping();
    await driver.setHostAllow(fixtures.baseUrl, 'always');

    let serve: ServeHandle | null = null;
    if (needServe) {
      // Real claude — layer B is real-LLM-only. NON-default port + own state
      // dir so the developer's real `nff-brain serve` on 7373 keeps running.
      const port = Number(process.env.NFF_EVALS_SERVE_PORT ?? 7375);
      serve = await startServe({ evalsRoot, port, homeName: 'act-brain-home' });
      const ping = (await driver.ping()) as { paired?: boolean; pairedPort?: number } & { extVersion: string };
      if (!ping.paired || ping.pairedPort !== port) {
        const win = await serve.admin<{ code: string }>('/v1/admin/pair-window', { method: 'POST', body: {} });
        await driver.pair(port, win.code);
        console.log(`paired the bench extension with serve on :${port}`);
      }
    }
    return { fixtures, chrome, driver, serve };
  } catch (err) {
    chrome.kill();
    await fixtures.close();
    throw err;
  }
}

function makeCtx(session: Session, tabId: number, nonce: string): BenchCtx {
  return {
    driver: session.driver,
    fixtures: session.fixtures,
    tabId,
    nonce,
    pageUrl(page, params = {}) {
      const u = new URL(`${session.fixtures.baseUrl}/fixtures/${page}`);
      u.searchParams.set('run', nonce);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString();
    },
  };
}

async function cleanupCase(session: Session, tabId: number | null): Promise<void> {
  try {
    if (tabId !== null) {
      // Close every stray fixture tab the case may have left, then the case tab.
      const tabs = await session.driver.listTabs();
      for (const t of tabs) {
        if (t.tabId !== tabId && (t.url.includes('/fixtures/') || t.url.includes('/bench/dl/')) && !t.url.includes('idle.html')) {
          await session.driver.closeTab(t.tabId).catch(() => undefined);
        }
      }
      await session.driver.closeTab(tabId).catch(() => undefined);
    }
    await session.driver.detachAll();
  } catch {
    /* cleanup is best-effort */
  }
}

async function runConformance(session: Session, c: ActConformanceCase): Promise<ScenarioResult> {
  const nonce = randomBytes(4).toString('hex');
  const started = Date.now();
  let tabId: number | null = null;
  let verdict: Verdict;
  try {
    if (!c.run) throw new Error(`${c.id} has live capabilities but no run() — write it when flipping the tag`);
    const ctx = makeCtx(session, -1, nonce);
    tabId = await session.driver.openTab(ctx.pageUrl(c.page));
    ctx.tabId = tabId;
    await session.driver.attach(tabId);
    verdict = await c.run(ctx);
  } catch (err) {
    verdict = { pass: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await cleanupCase(session, tabId);
  }

  const rep: RepResult = { ok: verdict.pass, detail: verdict.detail, durationMs: Date.now() - started };
  let outcome: Outcome;
  let reason: string | undefined;
  if (c.knownGap) {
    if (verdict.pass) {
      outcome = 'fail';
      reason = `known-gap marker is STALE — the engine now passes; remove knownGap from ${c.id}`;
    } else {
      outcome = 'known-gap';
      reason = c.knownGap;
    }
  } else {
    outcome = verdict.pass ? 'pass' : 'fail';
    if (!verdict.pass) reason = verdict.detail;
  }
  return { id: c.id, title: c.title, outcome, reason, reps: [rep] };
}

const AGENT_DEFAULT_TIMEOUT_MS = 240_000;

/** Where this run's artifacts (transcripts) land — set once by main(). */
let artifactDir = '';

function dumpTranscript(s: ActAgentScenario, rep: number, run: ActRunView | null): string[] {
  if (!artifactDir || !run) return [];
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    const file = path.join(artifactDir, `${s.id}-rep${rep}-transcript.json`);
    fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\n');
    return [file];
  } catch {
    return [];
  }
}

async function runAgentRep(session: Session, s: ActAgentScenario, repIndex = 0): Promise<RepResult> {
  const nonce = randomBytes(4).toString('hex');
  const started = Date.now();
  let tabId: number | null = null;
  try {
    const ctx = makeCtx(session, -1, nonce);
    tabId = await session.driver.openTab(ctx.pageUrl(s.page));
    ctx.tabId = tabId;

    const goal = s.goal.replaceAll('{base}', session.fixtures.baseUrl).replaceAll('{nonce}', nonce);
    const start = await session.driver.actStart(goal, tabId, s.maxActions, 'auto');
    if (start.awaitingGrant) await session.driver.actGrant('always');

    const deadline = Date.now() + (s.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS);
    let run: ActRunView | null = null;
    for (;;) {
      await sleep(2000);
      run = await session.driver.actStatus();
      if (!run) throw new Error('act run vanished mid-flight');
      if (['done', 'stopped', 'error'].includes(run.phase)) break;
      if (Date.now() > deadline) {
        await session.driver.actStop();
        await sleep(5000);
        run = await session.driver.actStatus();
        break;
      }
    }

    const verdict = s.verify
      ? await s.verify(ctx, run!)
      : ({ pass: run!.phase === 'done', detail: `phase ${run!.phase}` } as Verdict);
    const phaseNote = run ? ` [phase=${run.phase}, actions=${run.actionsTaken}/${run.maxActions}]` : '';
    const artifacts = dumpTranscript(s, repIndex, run);
    return { ok: verdict.pass, detail: verdict.detail + phaseNote, durationMs: Date.now() - started, artifacts };
  } catch (err) {
    return { ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - started };
  } finally {
    await session.driver.actEnd().catch(() => undefined);
    await cleanupCase(session, tabId);
  }
}

async function runAgent(session: Session, s: ActAgentScenario, repOverride?: number): Promise<ScenarioResult> {
  const repCount = repOverride ?? s.reps;
  const reps: RepResult[] = [];
  for (let i = 0; i < repCount; i++) {
    console.log(`  rep ${i + 1}/${repCount}…`);
    reps.push(await runAgentRep(session, s, i + 1));
  }
  const passRate = reps.filter((r) => r.ok).length / reps.length;
  const pass = passRate >= s.passRate;
  return {
    id: s.id,
    title: s.title,
    outcome: pass ? 'pass' : 'fail',
    reason: pass ? undefined : reps.map((r) => r.detail).find((d) => d),
    reps,
    passRate,
    requiredRate: s.passRate,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const caps = loadCapabilities();
  const tier = activeTier();

  const all: AnyActCase[] = [
    ...(args.layer !== 'agent' ? ACT_CASES : []),
    ...(args.layer !== 'engine' ? ACT_AGENT_SCENARIOS : []),
  ];
  const selected = all.filter(
    (c) => (args.id === undefined || c.id === args.id) && (args.family === undefined || c.family === args.family),
  );
  if (selected.length === 0) {
    console.error('no cases match the selection');
    process.exitCode = 1;
    return;
  }

  if (args.list || tier === 'none') {
    for (const c of selected) {
      const gate = gateOutcome(c, caps, tier);
      const status = gate ? `${gate.outcome}${gate.outcome === 'blocked' ? ` (${gate.reason})` : ''}` : 'runnable';
      console.log(`${c.id.padEnd(44)} ${(`[${c.family}]`).padEnd(11)} ${status}`);
    }
    if (args.list) return;
    console.log('\nnothing executed — set RUN_BROWSER=1 (engine layer) or RUN_EVALS=1 (both layers)');
  }

  const runnable = selected.filter((c) => gateOutcome(c, caps, tier) === null);
  const needServe = runnable.some((c) => isAgentScenario(c));

  const startedAt = new Date().toISOString();
  artifactDir = path.join(evalsRoot, 'artifacts', startedAt.replace(/[:.]/g, '-'));
  const results: ScenarioResult[] = [];
  let session: Session | null = null;
  try {
    if (runnable.length > 0) session = await openSession(needServe);

    for (const c of selected) {
      const gate = gateOutcome(c, caps, tier);
      if (gate) {
        results.push({ id: c.id, title: c.title, outcome: gate.outcome, reason: gate.reason, reps: [] });
        continue;
      }
      console.log(`▶ ${c.id}`);
      const result = isAgentScenario(c) ? await runAgent(session!, c, args.reps) : await runConformance(session!, c);
      const icon = result.outcome === 'pass' ? '✅' : result.outcome === 'known-gap' ? '🕳' : result.outcome === 'fail' ? '❌' : '•';
      console.log(`${icon} ${c.id} → ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
      results.push(result);
    }
  } finally {
    if (session) {
      session.chrome.kill();
      await session.fixtures.close().catch(() => undefined);
      await session.serve?.stop().catch(() => undefined);
    }
  }

  const card: Scorecard = {
    startedAt,
    finishedAt: new Date().toISOString(),
    tier: tier === 'real' ? 'act:real' : tier === 'browser' ? 'act:engine' : 'act:list',
    results,
  };
  if (runnable.length > 0) {
    const dir = writeScorecard(evalsRoot, card);
    console.log(`\nscorecard: ${path.join(dir, 'scorecard.md')}`);
  }
  const counts = new Map<Outcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  console.log([...counts.entries()].map(([o, n]) => `${n} ${o}`).join(' · '));
  if (results.some((r) => r.outcome === 'fail' || r.outcome === 'error')) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
