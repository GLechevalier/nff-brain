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
  // Standalone mode (no local server): BYOK provider + the in-browser brain.
  provider: 'nb.provider',
  brain: 'nb.brain',
  clipQueue: 'nb.clipQueue',
  clipSeen: 'nb.clipSeen',
  drain: 'nb.drain',
  migrationBackup: 'nb.migrationBackup',
  // Web-agent action engine (CDP): the single active run + per-origin grants.
  actRun: 'nb.actRun',
  actHostAllow: 'nb.actHostAllow',
  // Record-and-automate: the in-progress recording + the finished trace awaiting
  // distillation (standalone/BYOK path; paired posts to /v1/trace instead).
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
 * 'standalone' = no pairing stored but a BYOK provider key is configured: the
 * brain lives in extension storage and LLM calls go straight to the provider.
 * A stored pairing always wins — standalone never activates while one exists.
 */
export type ConnectionPhase = 'unpaired' | 'connected' | 'disconnected' | 'rejected' | 'standalone';

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

// ── standalone mode: BYOK provider settings ─────────────────────────────────

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

// ── standalone mode: the in-browser brain ───────────────────────────────────

/**
 * nb.brain holds a core BrainFile VERBATIM (same schema as .nff-brain/
 * brain.json) so migration is a serialization, not a translation. ≤200 nodes
 * (MAX_CLIP_NODES) ≈ 300 KB against the 10 MB storage.local quota.
 */
export type StandaloneBrain = BrainFile;

/** Queued raw captures awaiting a drain — the browser analog of clips.jsonl. */
export const CLIP_QUEUE_MAX = 200;

/** Processed clip ids (at-least-once dedupe) — the analog of seenClipIds(). */
export const CLIP_SEEN_MAX = 500;

export type StandaloneClip = ClipRecord;

/**
 * THE DRAIN SCHEDULE LIVES HERE, not in the alarm — same discipline as
 * Health.nextProbeAtMs. The alarm is only a tick; this number on disk decides.
 */
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

/** A per-origin input consent the panel is waiting for the user to answer. */
export interface ActPendingGrant {
  origin: string;
  /** The verb class that triggered the prompt — see @nff-brain/core browserVerbs. */
  verbClass: string;
}

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
  /** When set, this run is REPLAYING that workflow node (origin 'workflow'). */
  workflowId?: string;
  tabId: number;
  actionsTaken: number;
  maxActions: number;
  /** Origins granted "once" earlier in THIS run (never persisted beyond it). */
  grantedOrigins: string[];
  pendingGrant: ActPendingGrant | null;
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
