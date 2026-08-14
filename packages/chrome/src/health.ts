// Connection-health arithmetic, kept pure so the whole state machine is
// testable without a browser. No chrome.*, no fetch.

import type { ConnectionPhase, Health } from './schema.js';

/** Backoff ladder in ms; the tail repeats once exhausted. */
export const PROBE_INTERVALS_MS = [60_000, 120_000, 300_000, 600_000, 900_000] as const;

export function nextIntervalMs(consecutiveFailures: number): number {
  const i = Math.min(Math.max(0, consecutiveFailures), PROBE_INTERVALS_MS.length - 1);
  return PROBE_INTERVALS_MS[i]!;
}

/**
 * How stale a successful probe may be before "connected" stops being honest.
 *
 * Without this, a worker that stops being woken — machine asleep, alarms
 * throttled — leaves the popup cheerfully showing "Connected · 142 nodes" from
 * twenty minutes ago. Three intervals is loose enough to survive one or two
 * missed alarms and tight enough to notice a sleeping laptop.
 */
export function stalenessMs(consecutiveFailures: number): number {
  return nextIntervalMs(consecutiveFailures) * 3;
}

/**
 * "Connected" means ALL of: paired, the last completed probe returned 200, its
 * body passed isStatusResponse, and that success is not stale.
 *
 * 'rejected' is sticky by design — only an explicit re-pair or a popup-driven
 * probe clears it.
 */
export function derivePhase(health: Health, paired: boolean, nowMs: number): ConnectionPhase {
  if (!paired) return 'unpaired';
  if (health.phase === 'rejected') return 'rejected';
  if (health.phase === 'workspace_mismatch') return 'workspace_mismatch';
  if (!health.lastOkAt) return 'disconnected';
  const age = nowMs - Date.parse(health.lastOkAt);
  if (!Number.isFinite(age) || age > stalenessMs(health.consecutiveFailures)) return 'disconnected';
  return health.consecutiveFailures === 0 ? 'connected' : 'disconnected';
}

export interface ProbeOutcome {
  ok: boolean;
  /** True for 401/403: the token is dead, so stop probing entirely. */
  rejected?: boolean;
  /** True for 409 workspace_mismatch: keep retrying on the normal backoff — see ConnectionPhase's doc comment. */
  mismatch?: boolean;
  error?: string;
  status?: {
    projectNodes: number;
    globalNodes: number;
    mergedNodes: number;
    workspaceRoot: string;
    serverVersion: string;
    queuePending: number;
  };
}

/** Fold one probe result into the stored health record. Pure. */
export function applyProbe(prev: Health, outcome: ProbeOutcome, nowMs: number): Health {
  const at = new Date(nowMs).toISOString();

  if (outcome.rejected) {
    return {
      ...prev,
      phase: 'rejected',
      lastErrorAt: at,
      lastError: outcome.error ?? 'pairing rejected',
      consecutiveFailures: prev.consecutiveFailures + 1,
      // Number.MAX_SAFE_INTEGER, not Infinity: this round-trips through JSON in
      // chrome.storage, and JSON.stringify(Infinity) is null.
      nextProbeAtMs: Number.MAX_SAFE_INTEGER,
    };
  }

  if (!outcome.ok) {
    const failures = prev.consecutiveFailures + 1;
    return {
      ...prev,
      phase: outcome.mismatch ? 'workspace_mismatch' : 'disconnected',
      lastErrorAt: at,
      lastError: outcome.error ?? 'could not reach the brain',
      consecutiveFailures: failures,
      nextProbeAtMs: nowMs + nextIntervalMs(failures),
    };
  }

  return {
    ...prev,
    phase: 'connected',
    lastOkAt: at,
    lastError: null,
    consecutiveFailures: 0,
    nextProbeAtMs: nowMs + nextIntervalMs(0),
    projectNodes: outcome.status?.projectNodes ?? prev.projectNodes,
    globalNodes: outcome.status?.globalNodes ?? prev.globalNodes,
    mergedNodes: outcome.status?.mergedNodes ?? prev.mergedNodes,
    workspaceRoot: outcome.status?.workspaceRoot ?? prev.workspaceRoot,
    serverVersion: outcome.status?.serverVersion ?? prev.serverVersion,
    queuePending: outcome.status?.queuePending ?? prev.queuePending,
  };
}

export function dueForProbe(health: Health, nowMs: number): boolean {
  return nowMs >= health.nextProbeAtMs;
}

/** "as of 4 min ago" — the popup's honesty about a stale success. */
export function relativeAge(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 45_000) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
