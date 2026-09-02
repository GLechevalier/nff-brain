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
import { getActivity, getLogVisits, setActivity } from './storage.js';

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

// ── page-visit log (chrome.tabs.onUpdated → "Navigated to LinkedIn — …") ─────
// Local only: never a clip, never allowlist-gated, never sent anywhere.

const VISIT_TAG = 'page-visit';

const SITE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  github: 'GitHub',
  google: 'Google',
  youtube: 'YouTube',
  stackoverflow: 'Stack Overflow',
  x: 'X',
  twitter: 'X',
  reddit: 'Reddit',
  wikipedia: 'Wikipedia',
};

/** "LinkedIn" from "www.linkedin.com"; unknown hosts get a capitalised label. */
export function siteLabel(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  // Second-to-last label so "en.wikipedia.org" → "wikipedia", not "en".
  // ponytail: two-part public suffixes ("bbc.co.uk" → "Co") need a PSL if it matters.
  const label = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
  if (!label) return '';
  return SITE_LABELS[label] ?? label[0]!.toUpperCase() + label.slice(1);
}

function visitTitle(url: string, pageTitle: string | undefined): string {
  const label = siteLabel(hostOf(url));
  const page = pageTitle?.trim() || url;
  return label ? `Navigated to ${label} — ${page}` : `Navigated to ${page}`;
}

function isVisitOf(r: ActivityRecord | undefined, url: string): boolean {
  return r !== undefined && r.text.startsWith(VISIT_TAG) && r.url === url.slice(0, ACTIVITY_URL_MAX);
}

export type VisitPlan = { kind: 'append'; item: NewActivity } | { kind: 'retitle'; title: string } | null;

/**
 * PURE — logVisit() persists. `newest` is the head of the buffer.
 * Full load: {status:'complete'} → append. SPA pushState: {url} on an
 * already-complete tab → append, and the later {title} event retitles it.
 */
export function planVisit(
  info: { status?: string; url?: string; title?: string },
  tab: { url?: string; title?: string; status?: string },
  newest: ActivityRecord | undefined,
): VisitPlan {
  const url = tab.url ?? '';
  if (!/^https?:\/\//.test(url)) return null;
  const known = isVisitOf(newest, url);
  if (info.title !== undefined && known) return { kind: 'retitle', title: visitTitle(url, info.title) };
  const loaded = info.status === 'complete' || (info.url !== undefined && tab.status === 'complete');
  // ponytail: a reload / return to the same url is not re-logged while it is still the newest row.
  if (!loaded || known) return null;
  return {
    kind: 'append',
    item: {
      id: crypto.randomUUID(),
      url,
      title: visitTitle(url, tab.title),
      text: `${VISIT_TAG}\n${url}`,
      delivery: 'delivered',
    },
  };
}

/** The chrome.tabs.onUpdated handler (registered top-level in sw.ts). */
export async function logVisit(
  info: { status?: string; url?: string; title?: string },
  tab: { url?: string; title?: string; status?: string },
): Promise<void> {
  if (!(await getLogVisits())) return;
  const all = await getActivity();
  const plan = planVisit(info, tab, all[0]);
  if (!plan) return;
  if (plan.kind === 'append') {
    await appendActivity(plan.item);
    return;
  }
  all[0] = { ...all[0]!, title: plan.title.slice(0, ACTIVITY_TITLE_MAX) };
  await setActivity(all);
}

// ── recent-capture dedupe (pure halves; capture.ts persists the ring) ────────

export function recentKey(kind: string, url: string | undefined, text: string): string {
  return `${kind}|${url ?? ''}|${text.slice(0, 200)}`;
}

export function seenRecently(
  ring: readonly RecentClip[],
  key: string,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
): boolean {
  return ring.some((r) => r.key === key && nowMs - r.atMs < windowMs);
}

export function pushRecent(
  ring: readonly RecentClip[],
  key: string,
  nowMs: number,
  windowMs: number = RECENT_WINDOW_MS,
  max: number = RECENT_MAX,
): RecentClip[] {
  const fresh = ring.filter((r) => nowMs - r.atMs < windowMs && r.key !== key);
  return [{ key, atMs: nowMs }, ...fresh].slice(0, max);
}
