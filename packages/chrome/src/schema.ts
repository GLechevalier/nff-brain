// The persisted contract. EVERYTHING the extension knows lives here, because
// the MV3 service worker is torn down after ~30s idle and re-created cold on the
// next event. A module-level variable holding any of this is a bug that only
// reproduces after you stop touching the browser for half a minute — see the
// comment block at the top of sw.ts for the four specific failure modes.
//
// No chrome.* and no node:* imports: vitest imports this directly, and so do
// both bundles.

import type { BrainFile } from '@nff-brain/core/types';
import type { ClipRecord } from '@nff-brain/core/clip';
import type { ModelSlot, ProviderId } from '@nff-brain/core/provider';
import type { TraceEvent, TraceRecord } from '@nff-brain/core/trace';

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
  agentAdapters: 'nb.agentAdapters',
  agentActionAllow: 'nb.agentActionAllow',
  navigateHostAllow: 'nb.navigateHostAllow',
  agentTab: 'nb.agentTab',
  // BYOK provider settings — LLM reasoning only (chat tool-calling, the web
  // agent's BYOK loop), never a graph store.
  provider: 'nb.provider',
  // LEGACY, migration-only: a pre-upgrade user's local brain/clip queue, kept
  // solely so migrate.ts's migrateIfNeeded() can finish draining it into the
  // paired server. No live feature writes these anymore. Delete once
  // telemetry/support confirms no legacy users remain.
  brain: 'nb.brain',
  clipQueue: 'nb.clipQueue',
  clipSeen: 'nb.clipSeen',
  drain: 'nb.drain',
  migrationBackup: 'nb.migrationBackup',
  // Web-agent action engine (CDP): the single active run + per-origin grants.
  actRun: 'nb.actRun',
  actHostAllow: 'nb.actHostAllow',
  // Record-and-automate: the in-progress recording + the finished trace
  // awaiting distillation (server-side via POST /v1/trace).
  traceActive: 'nb.traceActive',
  tracePending: 'nb.tracePending',
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
 *
 * 'workspace_mismatch' is ALSO not 'disconnected' or 'rejected': the token is
 * still valid, but `nff-brain serve` is now bound to a different project than
 * the one this pairing was made for (see client.ts's HttpError.workspaceMismatch).
 * Unlike 'rejected' it keeps retrying on the normal backoff — switching back to
 * the original workspace's server (or re-pairing for the new one) self-heals it.
 *
 * There is no standalone/offline phase: the brain graph always lives on a
 * paired `nff-brain serve`. A BYOK provider key (ProviderSettings below) only
 * ever powers LLM reasoning (chat tool-calling, the web agent's BYOK loop) —
 * never a substitute source of truth for the graph itself.
 */
export type ConnectionPhase = 'unpaired' | 'connected' | 'disconnected' | 'rejected' | 'workspace_mismatch';

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

// ── BYOK provider settings (LLM reasoning only) ─────────────────────────────

export interface ProviderTestResult {
  ok: boolean;
  at: string;
  /** Short and user-showable. NEVER the key, never a stack. */
  message: string;
}

export type ModelSlots = Record<ModelSlot, string>;

export interface ProviderSettings {
  provider: ProviderId;
  /**
   * The BYOK API key. Same posture as Pairing.token: it NEVER crosses the
   * popup/panel/options channel outward — not even a last-4 hint. Inbound
   * once, via the setProvider message; PublicState carries zero key material.
   */
  apiKey: string;
  models: ModelSlots;
  addedAt: string;
  lastTest: ProviderTestResult | null;
}

// ── legacy, migration-only: a pre-upgrade user's local brain ────────────────
//
// Nothing writes these anymore — see KEYS' comment above. They exist purely
// so migrate.ts's migrateIfNeeded() can finish draining a leftover local
// brain into the paired server. Delete this whole section (and migrate.ts's
// remaining storage.ts imports) once no legacy users remain.

/**
 * nb.brain holds a core BrainFile VERBATIM (same schema as .nff-brain/
 * brain.json) so migration is a serialization, not a translation. ≤200 nodes
 * (MAX_CLIP_NODES) ≈ 300 KB against the 10 MB storage.local quota.
 */
export type StandaloneBrain = BrainFile;

export type StandaloneClip = ClipRecord;

/** Only DEFAULT_DRAIN is still written (to clear a legacy drain schedule on migration). */
export interface DrainState {
  nextDrainAtMs: number;
  consecutiveFailures: number;
}

export const DEFAULT_DRAIN: DrainState = { nextDrainAtMs: 0, consecutiveFailures: 0 };

/**
 * Snapshot taken immediately before a migration pushes the standalone brain
 * into the local server — insurance against a bad first pairing. Overwritten
 * by the next migration, cleared manually.
 */
export interface MigrationBackup {
  brain: BrainFile;
  migratedAt: string;
}

// ── web-agent action engine (CDP) ────────────────────────────────────────────

export type ActRunPhase = 'running' | 'awaiting_grant' | 'stopping' | 'stopped' | 'done' | 'error';

export interface ActTranscriptEntry {
  at: string;
  kind: 'system' | 'thought' | 'action' | 'result';
  text: string;
  ok?: boolean;
}

/** Manual-mode's per-run capability grants — see decideAct() in actGate.ts. Never persisted beyond the run. */
export type ActManualCapability = 'observe' | 'interact' | 'destructive';

/**
 * Something the panel is waiting for the user to answer before the run can
 * proceed. 'origin' is the pre-existing "let the agent act on this site?"
 * consent, asked once before the loop starts. 'capability' is Manual mode's
 * per-action-type consent (first click, first read, …), asked mid-run and
 * answered with the same Once/Always/Never choices — Once allows just the
 * action in flight, Always sets ActRunState.manualGrants[verbClass] so the
 * rest of the run skips that prompt, Never denies just that one action.
 */
export type ActPendingGrant =
  | { kind: 'origin'; origin: string; verbClass: string }
  | { kind: 'capability'; verbClass: ActManualCapability; description: string };

/**
 * The single active action run. One globally, same structural fact as the
 * paired web-agent run — the browser has no workspace concept. Persisted so the
 * panel (a separate realm) can render it and so Stop survives a re-render; full
 * mid-run resume across worker death is a later milestone.
 */
export interface ActRunState {
  id: string; // act_<epochMs>_<6hex>
  phase: ActRunPhase;
  goal: string;
  /** Chat mode the run was started under — Manual asks per-capability permission (see actGate.ts); Plan/Auto never do. */
  mode: 'manual' | 'plan' | 'auto';
  /** When set, this run is REPLAYING that workflow node (origin 'workflow'). */
  workflowId?: string;
  tabId: number;
  actionsTaken: number;
  maxActions: number;
  /** Origins granted "once" earlier in THIS run (never persisted beyond it). */
  grantedOrigins: string[];
  /** Manual mode's "Always" answers for THIS run only — see ActManualCapability. */
  manualGrants: Partial<Record<ActManualCapability, true>>;
  pendingGrant: ActPendingGrant | null;
  /**
   * The panel's answer to the current pendingGrant, or null while still
   * waiting. Internal signaling only (not rendered) between answerPendingGrant
   * and the paused runVerb() call — reset to null every time a NEW pendingGrant
   * is posted, so a stale answer can never leak into the next prompt.
   */
  pendingGrantChoice: 'once' | 'always' | 'never' | null;
  transcript: ActTranscriptEntry[]; // capped at ACT_TRANSCRIPT_MAX
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export const ACT_TRANSCRIPT_MAX = 200;
export const ACT_MAX_ACTIONS_DEFAULT = 40;
export const ACT_MAX_ACTIONS_CEILING = 100;

/** Persisted per-origin input grants (nb.actHostAllow). "once" lives on the run, not here. */
export interface ActHostAllow {
  /** origin (scheme://host[:port]) → 'always' | 'never'. */
  byOrigin: Record<string, 'always' | 'never'>;
}

// ── record-and-automate ──────────────────────────────────────────────────────

/**
 * The recording in progress (nb.traceActive). Accumulated one event per
 * user interaction, capped so a runaway page cannot fill storage; hitting a cap
 * auto-stops the recording. `bytes` is the running serialized size for the cap.
 */
export interface TraceActiveState {
  recording: boolean;
  id: string;
  tabId: number;
  startedAt: string;
  startUrl: string;
  title?: string;
  /** TraceEvent[] from @nff-brain/core; kept as the wire shape. */
  events: TraceEvent[];
  bytes: number;
}

/** A finished recording awaiting distillation (standalone/BYOK path). */
export type TracePending = TraceRecord;

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
