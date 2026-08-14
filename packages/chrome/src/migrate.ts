// Standalone→paired migration: push the in-browser brain into the local
// server's GLOBAL brain, then hand over to thin-client mode.
//
// Invoked from runProbe()'s healthy branch (which pairWithServer's forced
// probe also reaches), so it inherits the probe's single-flight guarantee and
// is SELF-HEALING: a partial failure leaves everything local, and the next
// healthy probe simply tries again — /v1/import's deterministic id remapping
// makes the retry an idempotent upsert, never a fork.
//
// Order is load-bearing:
//   1. backup tombstone (nb.migrationBackup) BEFORE anything leaves;
//   2. POST /v1/import; apply `remapped` to activity nodeIds BEFORE any
//      retract could run (or "also remove nodes" under-deletes);
//   3. clear the local brain + seen ring + drain schedule;
//   4. re-post still-queued RAW clips through the ordinary /v1/clip path
//      (they become server clips and distill server-side).

import { DEFAULT_DRAIN } from './schema.js';
import type { ActivityRecord, Pairing, StandaloneBrain } from './schema.js';
import * as client from './client.js';
import type { ImportPayload } from './client.js';
import {
  getActivity,
  getBrain,
  getBrainModePref,
  getClipQueue,
  setActivity,
  setBrain,
  setClipQueue,
  setClipSeen,
  setDrainState,
  setMigrationBackup,
} from './storage.js';

/** Pure payload assembly — exported for tests. */
export function buildImportPayload(brain: StandaloneBrain, activity: readonly ActivityRecord[]): ImportPayload {
  const localIds = new Set(brain.nodes.map((n) => n.id));
  return {
    nodes: brain.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      category: n.category,
      content: n.content,
      sourceUrl: n.sourceUrl,
      x: n.x,
      y: n.y,
      size: n.size,
      color: n.color,
      recallCount: n.recallCount,
      // Recorded workflows carry a machine payload that a generic clip import
      // would flatten and lose — flag origin so the server preserves it
      // (validated server-side; never trusted as-is). Every other node stays
      // unlabeled and lands as a plain clip, same as before.
      ...(n.origin === 'workflow' && n.workflow ? { origin: 'workflow' as const, workflow: n.workflow } : {}),
    })),
    edges: brain.edges.map((e) => ({ from: e.from, to: e.to, strength: e.strength })),
    map: activity
      .filter((r) => r.clipId && r.nodeIds.some((id) => localIds.has(id)))
      .map((r) => ({ clipId: r.clipId!, nodeIds: r.nodeIds.filter((id) => localIds.has(id)) })),
  };
}

/** Pure remap application — exported for tests. Under-deleting retracts is the bug this prevents. */
export function applyRemap(
  activity: readonly ActivityRecord[],
  remapped: ReadonlyArray<{ from: string; to: string }>,
): { records: ActivityRecord[]; changed: boolean } {
  if (remapped.length === 0) return { records: [...activity], changed: false };
  const byFrom = new Map(remapped.map((r) => [r.from, r.to]));
  let changed = false;
  const records = activity.map((r) => {
    if (!r.nodeIds.some((id) => byFrom.has(id))) return r;
    changed = true;
    return { ...r, nodeIds: r.nodeIds.map((id) => byFrom.get(id) ?? id) };
  });
  return { records, changed };
}

/**
 * Best-effort, called only while paired and the server is healthy. Never
 * throws — a failure leaves all local state intact for the next probe.
 *
 * GATED on the user never having chosen a brain mode: with an explicit
 * nb.brainMode preference set, the local brain is a LIVE store (the BYOK clip
 * drain writes it, chat/agent retrieval reads it) and sweeping it into the
 * server here would destroy it behind the user's back. Only a true legacy
 * leftover — pre-upgrade data with no preference ever stored — migrates.
 */
export async function migrateIfNeeded(pairing: Pairing): Promise<void> {
  try {
    if ((await getBrainModePref()) !== null) return;
    const brain = await getBrain();
    const hasNodes = brain !== null && brain.nodes.length > 0;

    if (hasNodes) {
      await setMigrationBackup({ brain, migratedAt: new Date().toISOString() });
      const res = await client.postImport(pairing.port, pairing.token, buildImportPayload(brain, await getActivity()));

      const { records, changed } = applyRemap(await getActivity(), res.remapped);
      if (changed) await setActivity(records);

      // No serialization needed here anymore — nothing else ever mutates
      // nb.brain now that the standalone graph is gone (unlike the old
      // brainStore.ts-serialized clear, which guarded against a concurrent
      // drain/retract that no longer exists).
      await setBrain(null);
      await setClipSeen([]);
      await setDrainState(DEFAULT_DRAIN);
      // A pre-upgrade install may still have the legacy drain alarm armed —
      // clear it once so it doesn't keep waking the worker for nothing.
      await chrome.alarms.clear('nb.drainClips').catch(() => undefined);
    }

    // Raw clips that never got distilled locally become ordinary server clips.
    const queue = await getClipQueue();
    if (queue.length === 0) return;
    const activity = await getActivity();
    for (const r of queue) {
      const res = await client.postClip(pairing.port, pairing.token, {
        kind: r.kind,
        text: r.text ?? '',
        url: r.url,
        title: r.title,
        capturedAt: r.at,
      });
      // Re-key the matching activity record onto the server's clip id so the
      // clips-map poll can fill its nodeIds after the server-side drain.
      const rec = activity.find((a) => a.clipId === r.id);
      if (rec) rec.clipId = res.id;
      // Shrink the stored queue as we go — a mid-loop worker kill re-posts at
      // most one clip (the server-side drain dedupes near-identical text).
      await setClipQueue((await getClipQueue()).filter((q) => q.id !== r.id));
    }
    await setActivity(activity);
  } catch {
    /* best-effort; the next healthy probe retries */
  }
}
