// The act-benchmark wire contract between the evals fixture server (node side,
// packages/evals) and the extension's bench driver (packages/chrome, present
// ONLY in NFF_BRAIN_BENCH=1 builds — zip.mjs refuses to package a dist that
// contains BENCH_SENTINEL, so this protocol can never ship to the store).
//
// Transport: the driver long-polls the fixture server over loopback
// (GET /bench/poll) and posts one result per command (POST /bench/result).
// The harness never opens a CDP connection of its own — empirically,
// a Playwright/CDP client attached to page targets EVICTS the extension's
// chrome.debugger session, which is the very engine under test.
//
// Browser-safe: types + constants only, no node: imports (pinned by
// packages/core/test/webviewImports.test.ts).

/** Appears verbatim in bench builds of dist/sw.js; zip.mjs refuses it. */
export const BENCH_SENTINEL = '__NFF_BENCH_DRIVER__';

/**
 * Fixture server port. Fixed (not env-resolved here) because the extension
 * bundle bakes it in — changing it means rebuilding the bench extension, so
 * the override env var NFF_EVALS_FIXTURE_PORT must match a matching rebuild.
 */
export const BENCH_DEFAULT_PORT = 8917;

export const BENCH_POLL_PATH = '/bench/poll';
export const BENCH_RESULT_PATH = '/bench/result';
export const BENCH_LOG_PATH = '/bench/log';
export const BENCH_REPORT_PATH = '/bench/report';

/** How long the server holds an empty poll before answering 204. Must stay
 *  well under the ~30s MV3 idle kill so every poll response is a fresh event. */
export const BENCH_POLL_HOLD_MS = 20_000;

// ── commands (server → driver) ───────────────────────────────────────────────

export type BenchGrantChoice = 'once' | 'always' | 'never';

export type BenchCmd =
  | { kind: 'ping' }
  | { kind: 'pair'; port: number; code: string }
  | { kind: 'setHostAllow'; origin: string; choice: 'always' | 'never' }
  | { kind: 'openTab'; url: string }
  | { kind: 'closeTab'; tabId: number }
  | { kind: 'listTabs' }
  | { kind: 'attach'; tabId: number }
  | { kind: 'detachAll' }
  /** Layer A: execute one BrowserVerb directly (validated driver-side). */
  | { kind: 'verb'; tabId: number; verb: unknown }
  | { kind: 'getZoom'; tabId: number }
  /** Layer B: start/observe/stop a full agent run. */
  | { kind: 'actStart'; goal: string; tabId: number; maxActions?: number; mode?: 'manual' | 'plan' | 'auto' }
  | { kind: 'actStatus' }
  | { kind: 'actGrant'; choice: BenchGrantChoice }
  | { kind: 'actStop' }
  | { kind: 'actEnd' };

export type BenchCmdKind = BenchCmd['kind'];

/** What GET /bench/poll answers with when a command is queued. */
export interface BenchPollCmd {
  cmdId: string;
  cmd: BenchCmd;
}

/** GET /bench/poll body: a command, a retirement order, or (204) nothing. */
export type BenchPollResponse = BenchPollCmd | { retire: true };

// ── results (driver → server) ────────────────────────────────────────────────

export interface BenchCmdResult {
  cmdId: string;
  ok: boolean;
  /** Short, human-readable — present when ok:false. */
  error?: string;
  /** Command-specific payload (BenchTabInfo[], BenchVerbResult, ActRunView…). */
  data?: unknown;
}

export interface BenchTabInfo {
  tabId: number;
  active: boolean;
  url: string;
  title: string;
}

/** Mirror of the engine's VerbResult, snapshot kept as unknown for transport. */
export interface BenchVerbResult {
  ok: boolean;
  resultText: string;
  snapshot?: unknown;
  newTabId?: number;
}

/**
 * The harness-visible view of ActRunState — the structural subset the evals
 * verify() functions may rely on. The chrome side maps its ActRunState into
 * this shape (assignment-compatible today; the mapping is the compatibility
 * seam if the storage schema ever diverges).
 */
export interface ActRunView {
  id: string;
  phase: 'running' | 'awaiting_grant' | 'stopping' | 'stopped' | 'done' | 'error';
  goal: string;
  mode: 'manual' | 'plan' | 'auto';
  tabId: number;
  actionsTaken: number;
  maxActions: number;
  transcript: { at: string; kind: 'system' | 'thought' | 'action' | 'result'; text: string; ok?: boolean }[];
  startedAt: string;
  updatedAt: string;
  error?: string;
  pendingGrant?: unknown;
}

/** Driver hello, posted as a log line at loop start (diagnostics only). */
export interface BenchHello {
  sentinel: typeof BENCH_SENTINEL;
  boot: string;
  extVersion?: string;
}

// ── fixture-page event reporting (page → server, via bench.js) ───────────────

/** One recorded DOM event from an instrumented fixture page. */
export interface BenchPageEvent {
  /** ms since page load (performance.now(), rounded). */
  t: number;
  type: string;
  /** data-bench name, else element id, else lowercase tag. */
  target: string;
  [extra: string]: unknown;
}

/** POST /bench/report body — a batch from one fixture-page instance. */
export interface BenchPageReport {
  /** The ?run=<nonce> the harness opened the page with ('' when absent). */
  run: string;
  /** Fixture page basename, e.g. 'pointer.html'. */
  page: string;
  /** Per-load unique id — distinguishes reloads of the same page+run. */
  instance: string;
  events: BenchPageEvent[];
  /** Page-defined state summary (form values, slider position, list order…). */
  state?: Record<string, unknown>;
}

// ── validation (shallow — both ends are local and trusted; this catches
//     protocol drift, not attackers) ─────────────────────────────────────────

const CMD_KINDS: readonly BenchCmdKind[] = [
  'ping', 'pair', 'setHostAllow', 'openTab', 'closeTab', 'listTabs', 'attach',
  'detachAll', 'verb', 'getZoom', 'actStart', 'actStatus', 'actGrant', 'actStop', 'actEnd',
];

export function isBenchCmdKind(v: unknown): v is BenchCmdKind {
  return typeof v === 'string' && (CMD_KINDS as readonly string[]).includes(v);
}

export function isBenchPollCmd(v: unknown): v is BenchPollCmd {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.cmdId !== 'string' || o.cmdId === '') return false;
  const cmd = o.cmd as Record<string, unknown> | undefined;
  return typeof cmd === 'object' && cmd !== null && isBenchCmdKind(cmd.kind);
}

export function isBenchPageReport(v: unknown): v is BenchPageReport {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.run === 'string' &&
    typeof o.page === 'string' &&
    typeof o.instance === 'string' &&
    Array.isArray(o.events)
  );
}
