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
} from './schema.js';
import type { ActivityRecord, Delivery } from './schema.js';
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

export async function markDelivery(id: string, delivery: Delivery): Promise<void> {
  const all = await getActivity();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return;
  all[i] = { ...all[i]!, delivery };
  await setActivity(all);
}

export async function clearActivity(): Promise<void> {
  await setActivity([]);
}

/** How many brain nodes are still traceable to buffered activity. */
export function removableNodeCount(records: readonly ActivityRecord[]): number {
  return records.reduce((n, r) => n + r.nodeIds.length, 0);
}
