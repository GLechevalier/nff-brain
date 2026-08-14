// BENCH BUILDS ONLY (NFF_BRAIN_BENCH=1 — see build.mjs). The act-benchmark
// driver: long-polls the evals fixture server over loopback for commands and
// executes them in the SW realm, where the act engine's real entry points live.
//
// Why this exists at all: the benchmark measures the CDP action engine, and a
// harness-side CDP client (Playwright or raw) attached to page targets EVICTS
// chrome.debugger — the engine under test. So the harness holds no CDP
// connection; this driver is its only hand inside the browser. It can never
// ship: zip.mjs refuses any dist/sw.js containing BENCH_SENTINEL.
//
// MV3 discipline: no module-level mutable state — loop state lives in closure,
// and duplicate-loop suppression is delegated to the SERVER (loop-active probe
// + boot-id retirement), which survives worker death by construction. The
// long-poll hold (20s) sits under the ~30s idle kill so every poll response is
// a fresh event; the alarm below revives the loop after any death.

import {
  BENCH_DEFAULT_PORT,
  BENCH_LOG_PATH,
  BENCH_POLL_PATH,
  BENCH_RESULT_PATH,
  BENCH_SENTINEL,
  isBenchPollCmd,
  type ActRunView,
  type BenchCmd,
  type BenchCmdResult,
  type BenchTabInfo,
} from '@nff-brain/core/benchProtocol';
import { validateBrowserVerb } from '@nff-brain/core/browserVerbs';
import { executeVerb } from './actEngine.js';
import { detach, ensureAttached } from './cdp.js';
import { pairWithServer } from './connection.js';
import { answerPendingGrant, endActionRun, startActionRun, stopActionRun } from './actRun.js';
import { getActHostAllow, getActRun, getPairing, setActHostAllow } from './storage.js';

const BASE = `http://127.0.0.1:${BENCH_DEFAULT_PORT}`;
const BENCH_ALARM = 'nb.benchLoop';
const OPEN_TAB_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(pathname: string, body: unknown): Promise<void> {
  try {
    await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* server gone — the loop's own poll failure ends it; the alarm revives */
  }
}

function log(line: string): void {
  void postJson(BENCH_LOG_PATH, { line });
}

// ── command execution ────────────────────────────────────────────────────────

async function waitTabComplete(tabId: number): Promise<void> {
  const deadline = Date.now() + OPEN_TAB_TIMEOUT_MS;
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() > deadline) throw new Error(`tab ${tabId} did not finish loading in ${OPEN_TAB_TIMEOUT_MS}ms`);
    await sleep(150);
  }
}

function toRunView(run: Awaited<ReturnType<typeof getActRun>>): ActRunView | null {
  if (!run) return null;
  return {
    id: run.id,
    phase: run.phase,
    goal: run.goal,
    mode: run.mode,
    tabId: run.tabId,
    actionsTaken: run.actionsTaken,
    maxActions: run.maxActions,
    transcript: run.transcript,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    error: run.error,
    pendingGrant: run.pendingGrant ?? undefined,
  };
}

async function execCmd(cmd: BenchCmd): Promise<Omit<BenchCmdResult, 'cmdId'>> {
  switch (cmd.kind) {
    case 'ping': {
      const pairing = await getPairing();
      return {
        ok: true,
        data: {
          extVersion: chrome.runtime.getManifest().version,
          sentinel: BENCH_SENTINEL,
          paired: pairing !== null,
          pairedPort: pairing?.port,
        },
      };
    }

    case 'pair': {
      const r = await pairWithServer(cmd.port, cmd.code);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'pairing failed' };
    }

    case 'setHostAllow': {
      const state = await getActHostAllow();
      state.byOrigin[cmd.origin] = cmd.choice;
      await setActHostAllow(state);
      return { ok: true };
    }

    case 'openTab': {
      const tab = await chrome.tabs.create({ url: cmd.url, active: true });
      if (tab.id === undefined) return { ok: false, error: 'tab was created without an id' };
      await waitTabComplete(tab.id);
      return { ok: true, data: { tabId: tab.id } };
    }

    case 'closeTab':
      await chrome.tabs.remove(cmd.tabId);
      return { ok: true };

    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      const data: BenchTabInfo[] = tabs.map((t) => ({
        tabId: t.id ?? -1,
        active: t.active,
        url: t.url ?? '',
        title: t.title ?? '',
      }));
      return { ok: true, data };
    }

    case 'attach':
      await ensureAttached(cmd.tabId);
      return { ok: true };

    case 'detachAll': {
      const targets = await chrome.debugger.getTargets();
      for (const t of targets) {
        if (t.attached && t.tabId !== undefined) await detach(t.tabId);
      }
      return { ok: true };
    }

    case 'verb': {
      const verb = validateBrowserVerb(cmd.verb);
      if (!verb) return { ok: false, error: 'invalid BrowserVerb payload' };
      await ensureAttached(cmd.tabId);
      const r = await executeVerb(cmd.tabId, verb);
      // The full VerbResult travels back — snapshot included, so the harness
      // can chain ref-addressed verbs without a CDP connection of its own.
      return { ok: true, data: r };
    }

    case 'getZoom': {
      const zoom = await chrome.tabs.getZoom(cmd.tabId);
      return { ok: true, data: { zoom } };
    }

    case 'actStart': {
      const r = await startActionRun(cmd.goal, cmd.tabId, cmd.maxActions, undefined, cmd.mode ?? 'auto');
      return { ok: r.ok, error: r.error, data: { runId: r.runId, awaitingGrant: r.awaitingGrant } };
    }

    case 'actStatus':
      return { ok: true, data: toRunView(await getActRun()) };

    case 'actGrant':
      await answerPendingGrant(cmd.choice);
      return { ok: true };

    case 'actStop':
      await stopActionRun();
      return { ok: true };

    case 'actEnd':
      await endActionRun();
      return { ok: true };
  }
}

// ── the loop ─────────────────────────────────────────────────────────────────

async function runLoop(boot: string): Promise<void> {
  log(`hello boot=${boot} sentinel=${BENCH_SENTINEL} v=${chrome.runtime.getManifest().version}`);
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${BENCH_POLL_PATH}?boot=${boot}`);
    } catch {
      return; // server gone — the alarm restarts the loop once it is back
    }
    if (res.status === 204) continue;
    if (!res.ok) return;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    if (typeof body === 'object' && body !== null && (body as { retire?: boolean }).retire) return;
    if (!isBenchPollCmd(body)) continue;
    let result: Omit<BenchCmdResult, 'cmdId'>;
    try {
      result = await execCmd(body.cmd);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await postJson(BENCH_RESULT_PATH, { cmdId: body.cmdId, ...result });
  }
}

/**
 * Start a loop unless the server says one is already live. Duplicate-loop
 * suppression is server-side on purpose: the server sees its own open poll
 * socket (worker death closes it), so this needs no state in the worker.
 */
export async function ensureBenchLoop(): Promise<void> {
  let active: boolean;
  try {
    const res = await fetch(`${BASE}/bench/loop-active`);
    active = res.ok && ((await res.json()) as { active?: boolean }).active === true;
  } catch {
    return; // no server listening — nothing to drive; the alarm retries
  }
  if (active) return;
  void runLoop(crypto.randomUUID());
}

// ── liveness — registered synchronously at module top level (this module is
//    imported synchronously by swBench.ts, the bench entry) ──────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BENCH_ALARM, { periodInMinutes: 0.5 });
  void ensureBenchLoop();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BENCH_ALARM, { periodInMinutes: 0.5 });
  void ensureBenchLoop();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BENCH_ALARM) void ensureBenchLoop();
});
// Every cold start of the worker also kicks the loop — the alarm is only the
// backstop for the case where the worker died with no event source left.
chrome.alarms.create(BENCH_ALARM, { periodInMinutes: 0.5 });
void ensureBenchLoop();
