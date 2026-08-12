// Orchestration: probe / pair / unpair. Reads and writes storage, calls the
// client, and derives the phase — but holds NO state of its own between calls,
// because the service worker it runs in is destroyed after ~30s idle.

import { paintBadge } from './badge.js';
import * as client from './client.js';
import { HttpError } from './client.js';
import { applyProbe, derivePhase, dueForProbe } from './health.js';
import { DEFAULT_HEALTH } from './schema.js';
import type { ConnectionPhase } from './schema.js';
import { getCapture, getHealth, getPairing, setHealth, setPairing } from './storage.js';

/**
 * The ONE permitted module-level variable in the whole extension: an in-flight
 * probe promise, so an alarm and a popup firing in the same worker lifetime do
 * not double-fetch. Losing it when the worker dies is harmless — the worst case
 * is one extra request.
 */
let inFlightProbe: Promise<ConnectionPhase> | null = null;

export async function currentPhase(nowMs = Date.now()): Promise<ConnectionPhase> {
  const [pairing, health] = await Promise.all([getPairing(), getHealth()]);
  return derivePhase(health, pairing !== null, nowMs);
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
  } catch (err) {
    const http = err instanceof HttpError ? err : null;
    next = applyProbe(health, {
      ok: false,
      rejected: http?.rejected ?? false,
      error: http?.message ?? 'probe failed',
    }, now);
  }

  await setHealth(next);
  const phase = derivePhase(next, true, now);
  await paintBadge(phase, (await getCapture()).enabled);
  return phase;
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
