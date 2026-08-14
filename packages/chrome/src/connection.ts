// Orchestration: probe / pair / unpair. Reads and writes storage, calls the
// client, and derives the phase — but holds NO state of its own between calls,
// because the service worker it runs in is destroyed after ~30s idle.

import { applyClipMap, hasUnresolvedClips } from './activity.js';
import { paintBadge } from './badge.js';
import * as client from './client.js';
import { HttpError } from './client.js';
import { applyProbe, derivePhase, dueForProbe } from './health.js';
import { migrateIfNeeded } from './migrate.js';
import { DEFAULT_HEALTH } from './schema.js';
import type { ConnectionPhase, Pairing } from './schema.js';
import {
  getActivity,
  getCapture,
  getHealth,
  getPairing,
  setActivity,
  setHealth,
  setPairing,
} from './storage.js';

/**
 * One of the THREE permitted module-level variables in the whole extension
 * (the others are actStore.ts's and traceCapture.ts's serialization chains):
 * an in-flight probe promise, so an alarm and a popup firing in the same
 * worker lifetime do not double-fetch. Losing it when the worker dies is
 * harmless — the worst case is one extra request.
 */
let inFlightProbe: Promise<ConnectionPhase> | null = null;

export async function currentPhase(nowMs = Date.now()): Promise<ConnectionPhase> {
  const [pairing, health] = await Promise.all([getPairing(), getHealth()]);
  if (pairing === null) return 'unpaired';
  return derivePhase(health, true, nowMs);
}

/**
 * One health probe.
 *
 * `force` is what the popup sends on open: a popup being opened is the
 * strongest possible signal that the user wants current information, so it
 * bypasses the stored schedule. The alarm path does not.
 */
export async function probe(opts: { force?: boolean } = {}): Promise<ConnectionPhase> {
  if (inFlightProbe) return inFlightProbe;
  inFlightProbe = runProbe(opts).finally(() => {
    inFlightProbe = null;
  });
  return inFlightProbe;
}

async function runProbe({ force }: { force?: boolean }): Promise<ConnectionPhase> {
  const pairing = await getPairing();
  if (!pairing) {
    await setHealth({ ...DEFAULT_HEALTH });
    await paintBadge('unpaired', (await getCapture()).enabled);
    return 'unpaired';
  }

  const now = Date.now();
  const health = await getHealth();
  if (!force && !dueForProbe(health, now)) {
    return derivePhase(health, true, now);
  }

  let next;
  try {
    const s = await client.status(pairing.port, pairing.token);
    next = applyProbe(health, {
      ok: true,
      status: {
        projectNodes: s.workspace.nodes,
        globalNodes: s.global.nodes,
        mergedNodes: s.merged.nodes,
        workspaceRoot: s.workspace.root,
        serverVersion: s.version,
        queuePending: s.queue.pending,
      },
    }, now);
    // Piggyback on the healthy probe: resolve clip→node mappings the drain has
    // reported since. One extra request, and only while something is unresolved.
    await resolveClipMappings(pairing);
    // Second piggyback: migrate any standalone brain/queue into this server.
    // Early-returns when there is nothing local; self-heals partial failures
    // because the next healthy probe lands here again (import is idempotent).
    await migrateIfNeeded(pairing);
  } catch (err) {
    const http = err instanceof HttpError ? err : null;
    next = applyProbe(health, {
      ok: false,
      rejected: http?.rejected ?? false,
      mismatch: http?.workspaceMismatch ?? false,
      error: http?.message ?? 'probe failed',
    }, now);
  }

  await setHealth(next);
  const phase = derivePhase(next, true, now);
  await paintBadge(phase, (await getCapture()).enabled);
  return phase;
}

/**
 * Fill ActivityRecord.nodeIds from the drain's ledger. Failure is swallowed —
 * this is best-effort enrichment riding a probe that already succeeded, and the
 * next probe simply tries again (the unresolved records are still unresolved).
 */
async function resolveClipMappings(pairing: Pairing): Promise<void> {
  try {
    const records = await getActivity();
    if (!hasUnresolvedClips(records)) return;
    const res = await client.getClipsMap(pairing.port, pairing.token);
    const { records: next, changed } = applyClipMap(records, res.map);
    if (changed) await setActivity(next);
  } catch {
    /* best-effort; the next probe retries */
  }
}

export interface PairOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Exchange a pairing code for a long-lived token. The code is what the user
 * types; the token never appears on screen or in clipboard history.
 */
export async function pairWithServer(port: number, code: string): Promise<PairOutcome> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'that is not a valid port' };
  try {
    const res = await client.pair(port, code.trim());
    await setPairing({
      port,
      token: res.token,
      clientId: res.clientId,
      serverId: res.serverId,
      pairedAt: new Date().toISOString(),
    });
    // Clear any 'rejected' phase left over from the pairing we just replaced.
    await setHealth({ ...DEFAULT_HEALTH, phase: 'disconnected' });
    await ensureAlarm();
    await probe({ force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof HttpError ? err.message : 'could not reach the brain' };
  }
}

export async function unpair(): Promise<void> {
  await setPairing(null);
  await setHealth({ ...DEFAULT_HEALTH });
  await chrome.alarms.clear(HEALTH_ALARM);
  await paintBadge('unpaired', (await getCapture()).enabled);
}

export const HEALTH_ALARM = 'nb.health';

/**
 * The alarm is a TICK, not the schedule — the handler consults
 * health.nextProbeAtMs and returns immediately when it is not due. That is what
 * lets the backoff survive worker death: it is a number on disk, not a timer.
 */
export async function ensureAlarm(): Promise<void> {
  if (!(await getPairing())) {
    await chrome.alarms.clear(HEALTH_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(HEALTH_ALARM);
  if (!existing) chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
}
