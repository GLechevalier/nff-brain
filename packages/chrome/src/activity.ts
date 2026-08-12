// The local activity buffer: a capped ring of what this extension captured.
//
// It exists so "Clear activity history" can be honest. Each record carries the
// node ids the CLI reported creating from that clip — EMPTY until a drain
// reports a mapping back, which is why the clear dialog only offers to remove
// nodes when there is something it can actually remove.

import {
  ACTIVITY_MAX,
  ACTIVITY_TEXT_MAX,
  ACTIVITY_TITLE_MAX,
  ACTIVITY_URL_MAX,
  RECENT_MAX,
  RECENT_WINDOW_MS,
} from './schema.js';
import type { ActivityRecord, Delivery, RecentClip } from './schema.js';
import { getActivity, setActivity } from './storage.js';

export interface NewActivity {
  id: string;
  url: string;
  title: string;
  text: string;
  delivery: Delivery;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function appendActivity(item: NewActivity, now = new Date()): Promise<ActivityRecord[]> {
  const record: ActivityRecord = {
    id: item.id,
    at: now.toISOString(),
    host: hostOf(item.url),
    url: item.url.slice(0, ACTIVITY_URL_MAX),
    title: item.title.slice(0, ACTIVITY_TITLE_MAX),
    text: item.text.slice(0, ACTIVITY_TEXT_MAX),
    delivery: item.delivery,
    nodeIds: [],
  };
  // Newest first, oldest dropped — worst case ~500 KB, comfortably inside the
  // storage.local quota, which is why unlimitedStorage is not requested.
  const next = [record, ...(await getActivity())].slice(0, ACTIVITY_MAX);
  await setActivity(next);
  return next;
}

export async function markDelivery(id: string, delivery: Delivery, clipId?: string): Promise<void> {
  const all = await getActivity();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return;
  all[i] = { ...all[i]!, delivery, ...(clipId ? { clipId } : {}) };
  await setActivity(all);
}

export async function clearActivity(): Promise<void> {
  await setActivity([]);
}

/** How many brain nodes are still traceable to buffered activity. */
export function removableNodeCount(records: readonly ActivityRecord[]): number {
  return records.reduce((n, r) => n + r.nodeIds.length, 0);
}

/** Any record still waiting for the drain to report where its clip landed? */
export function hasUnresolvedClips(records: readonly ActivityRecord[]): boolean {
  return records.some((r) => r.clipId !== undefined && r.nodeIds.length === 0);
}

/**
 * Fill nodeIds from a /v1/clips/map response. PURE — the caller persists.
 * Only empty nodeIds are filled, so re-applying the same map is a no-op and a
 * later (never expected, but wire is wire) conflicting map cannot rewrite what
 * the user was already shown.
 */
export function applyClipMap(
  records: readonly ActivityRecord[],
  map: ReadonlyArray<{ clipId: string; nodeIds: string[] }>,
): { records: ActivityRecord[]; changed: boolean } {
  const byClip = new Map(map.map((m) => [m.clipId, m.nodeIds]));
  let changed = false;
  const next = records.map((r) => {
    if (!r.clipId || r.nodeIds.length > 0) return r;
    const nodeIds = byClip.get(r.clipId);
    if (!nodeIds || nodeIds.length === 0) return r;
    changed = true;
    return { ...r, nodeIds: [...nodeIds] };
  });
  return { records: changed ? next : [...records], changed };
}

// ── recent-capture dedupe (pure halves; capture.ts persists the ring) ────────

export function recentKey(kind: string, url: string | undefined, text: string): string {
  return `${kind}|${url ?? ''}|${text.slice(0, 200)}`;
}

export function seenRecently(ring: readonly RecentClip[], key: string, nowMs: number): boolean {
  return ring.some((r) => r.key === key && nowMs - r.atMs < RECENT_WINDOW_MS);
}

export function pushRecent(ring: readonly RecentClip[], key: string, nowMs: number): RecentClip[] {
  const fresh = ring.filter((r) => nowMs - r.atMs < RECENT_WINDOW_MS && r.key !== key);
  return [{ key, atMs: nowMs }, ...fresh].slice(0, RECENT_MAX);
}
