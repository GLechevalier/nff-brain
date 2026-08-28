// Company brain sync — push the employee's brain to nff-admin.
//
// One narrow job: POST the whole brain (minus nodes the employee marked
// `private` — buildCompanySyncPayload is THE shared filter, the VS Code
// extension uses the same one) to nff-admin's employee ingest, authenticated
// by the per-employee token minted in nff-admin's Users tab. The token has the
// same posture as the CRM ingest secret: inbound once, never re-displayed,
// PublicState carries booleans only.
//
// Which brain: the paired server's merged brain when a pairing is live (it is
// the fuller one and carries flags set from VS Code — /v1/export returns nodes
// verbatim), else the local BYOK brain (nb.brain).
//
// ponytail: fire-and-forget, no retry queue — a failed sync leaves a visible
// 'failed' activity row and auto mode retries on the next brain change.

import { buildCompanySyncPayload } from '@nff-brain/core/brainGraph';
import type { BrainEdge, BrainNode } from '@nff-brain/core/types';
import { appendActivity } from './activity.js';
import { readLocalBrain } from './brainStore.js';
import { getExport } from './client.js';
import { getBrainSync, getPairing, setBrainSync } from './storage.js';

// The origin pattern for the permission grant is protocol.ts's
// CRM_ORIGIN_PATTERN — same host, one grant covers both syncs.
export const BRAIN_INGEST_URL = 'https://admin.nanoforgeflow.com/api/tables/brain/ingest';

/**
 * Push the brain now. Returns a human-readable outcome for the panel; never
 * throws. A no-op (with a message) unless a token is saved and sync enabled.
 */
export async function syncBrainToCompany(): Promise<{ ok: boolean; message: string }> {
  const cfg = await getBrainSync();
  if (!cfg?.token) return { ok: false, message: 'no sync token saved' };
  if (!cfg.enabled) return { ok: false, message: 'company sync is disabled' };

  let nodes: BrainNode[];
  let edges: BrainEdge[];
  const pairing = await getPairing();
  if (pairing) {
    // Paired = the server's merged brain IS the brain. Never silently fall
    // back to the (usually empty) in-browser brain — that turned "old server
    // without /v1/export" into a baffling "this brain is empty" while the
    // panel showed 160 nodes. Surface the real failure instead.
    try {
      const exported = await getExport(pairing.port, pairing.token);
      ({ nodes, edges } = exported);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `could not read the paired brain (${detail}) — if \`nff-brain serve\` predates /v1/export, update and restart it`,
      };
    }
  } else {
    ({ nodes, edges } = await readLocalBrain());
  }

  const payload = buildCompanySyncPayload({ nodes, edges });
  // An empty push is never what the user meant — and since ingest is a FULL
  // REPLACE it would wipe a previously synced brain. Refuse instead of
  // "succeeding" with 0 nodes and stamping a misleading last-synced time.
  if (payload.nodes.length === 0) {
    return {
      ok: false,
      message:
        nodes.length === 0
          ? 'nothing to sync — this brain is empty (pair with `nff-brain serve`, or capture some clips first)'
          : 'nothing to sync — every node here is marked private',
    };
  }
  const id = crypto.randomUUID();
  try {
    const res = await fetch(BRAIN_INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-sync-token': cfg.token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as { synced?: number };
    const now = new Date().toISOString();
    await setBrainSync({ ...cfg, lastSyncedAt: now });
    await appendActivity({
      id,
      url: BRAIN_INGEST_URL,
      title: `Company sync: ${out.synced ?? payload.nodes.length} node(s) pushed`,
      text: `brain-sync ok\nnodes: ${payload.nodes.length} (of ${nodes.length} — private stay home)\nedges: ${payload.edges.length}`,
      delivery: 'delivered',
    });
    return { ok: true, message: `synced ${out.synced ?? payload.nodes.length} node(s)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendActivity({
      id,
      url: BRAIN_INGEST_URL,
      title: 'Company sync failed',
      text: `brain-sync error: ${message}`,
      delivery: 'failed',
    });
    return { ok: false, message };
  }
}
