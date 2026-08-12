// The persisted contract. EVERYTHING the extension knows lives here, because
// the MV3 service worker is torn down after ~30s idle and re-created cold on the
// next event. A module-level variable holding any of this is a bug that only
// reproduces after you stop touching the browser for half a minute — see the
// comment block at the top of sw.ts for the four specific failure modes.
//
// No chrome.* and no node:* imports: vitest imports this directly, and so do
// both bundles.

export const SCHEMA_VERSION = 1 as const;

/**
 * Separate top-level keys rather than one blob, for two reasons:
 * storage.onChanged then reports a fine-grained delta the popup can react to,
 * and a health write from the service worker can never clobber a concurrent
 * allowlist write from the popup.
 */
export const KEYS = {
  version: 'nb.version',
  pairing: 'nb.pairing',
  health: 'nb.health',
  capture: 'nb.capture',
  allowlist: 'nb.allowlist',
  activity: 'nb.activity',
  recent: 'nb.recent',
  recorders: 'nb.recorders',
  recorderSeen: 'nb.recorderSeen',
} as const;

// ── pairing ──────────────────────────────────────────────────────────────────

export interface Pairing {
  port: number;
  /** Long-lived bearer from POST /v1/pair. Never crosses the popup channel. */
  token: string;
  clientId: string;
  serverId: string;
  pairedAt: string;
}

// ── connection health ────────────────────────────────────────────────────────

/**
 * 'rejected' is NOT 'disconnected'. A 401 means the token is dead, so retrying
 * every minute forever is pure noise in the server log and pure battery drain.
 * It gets its own phase, its own copy, and no backoff.
 */
export type ConnectionPhase = 'unpaired' | 'connected' | 'disconnected' | 'rejected';

export interface Health {
  phase: ConnectionPhase;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  /** Short and user-showable. Never a stack. */
  lastError: string | null;
  consecutiveFailures: number;
  /**
   * Epoch ms. THE BACKOFF SCHEDULE LIVES HERE, not in the alarm — a number on
   * disk survives worker death, whereas alarms.create({delayInMinutes}) called
   * from inside a handler is fragile across restarts and impossible to reason
   * about.
   */
  nextProbeAtMs: number;
  // Last good /v1/status payload, so the popup paints numbers instantly on open
  // instead of showing a spinner while the first probe flies.
  projectNodes: number | null;
  globalNodes: number | null;
  mergedNodes: number | null;
  workspaceRoot: string | null;
  serverVersion: string | null;
  queuePending: number | null;
}

// ── capture master switch ────────────────────────────────────────────────────

export interface Capture {
  /** DEFAULT false. A memory tool that starts recording the moment it is
   *  installed is the wrong default, and it reads badly in store review. */
  enabled: boolean;
  changedAt: string;
}

// ── allowlist ────────────────────────────────────────────────────────────────

export interface AllowRule {
  /** Normalized: lowercase, punycode, no trailing dot, no brackets, no port. */
  host: string;
  includeSubdomains: boolean;
  addedAt: string;
}

export interface Allowlist {
  rules: AllowRule[];
}

// ── the local activity buffer ────────────────────────────────────────────────

export type Delivery = 'pending' | 'delivered' | 'failed';

export interface ActivityRecord {
  id: string;
  at: string;
  host: string;
  url: string; // ≤512
  title: string; // ≤256
  text: string; // ≤2000
  delivery: Delivery;
  /**
   * The server's own id for the delivered clip (`clp_…`, from POST /v1/clip).
   * Absent when delivery failed. This is the join key the clips-map poll uses
   * to fill nodeIds — without it the feedback loop cannot exist.
   */
  clipId?: string;
  /**
   * Node ids the CLI reported creating from this clip. Filled only when a drain
   * reports a mapping back. EMPTY MEANS we cannot honestly claim any node came
   * from this — and the clear-history UI must then not offer to delete any.
   */
  nodeIds: string[];
}

// ── recent-capture dedupe ring ──────────────────────────────────────────────

/**
 * Client-side dedupe: two identical captures inside the window produce ONE
 * clip. In storage, never a module variable — worker death would otherwise
 * reset the window every ~30s idle.
 */
export interface RecentClip {
  key: string;
  atMs: number;
}

export const RECENT_MAX = 20;
export const RECENT_WINDOW_MS = 10 * 60_000;

export const ACTIVITY_MAX = 500;
export const ACTIVITY_URL_MAX = 512;
export const ACTIVITY_TITLE_MAX = 256;
export const ACTIVITY_TEXT_MAX = 2000;

export interface StoredState {
  version: typeof SCHEMA_VERSION;
  pairing: Pairing | null;
  health: Health;
  capture: Capture;
  allowlist: Allowlist;
  activity: ActivityRecord[];
}

export const DEFAULT_HEALTH: Health = {
  phase: 'unpaired',
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextProbeAtMs: 0,
  projectNodes: null,
  globalNodes: null,
  mergedNodes: null,
  workspaceRoot: null,
  serverVersion: null,
  queuePending: null,
};

export const DEFAULTS: StoredState = {
  version: SCHEMA_VERSION,
  pairing: null,
  health: DEFAULT_HEALTH,
  capture: { enabled: false, changedAt: new Date(0).toISOString() },
  allowlist: { rules: [] },
  activity: [],
};
