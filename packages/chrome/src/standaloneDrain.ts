// The standalone clip pipeline: capture tail → nb.clipQueue → alarm-driven
// drain → provider one-shot → nodes in the in-browser brain. Mirrors
// packages/cli/src/clipDrain.ts, single-target (standalone clips are always
// 'global' — a browser tab is not "in" a project).
//
// Every drain condition is read from DISK in the handler — the alarm is only a
// tick, the schedule lives in nb.drain.nextDrainAtMs (the Health.nextProbeAtMs
// pattern). Fail-open throughout: an LLM/parse failure leaves the batch queued
// and backs off; the queue never drops a clip.
//
// The whole result lands through ONE commitDrain() call (storage.ts) scheduled
// on the brainStore chain: a worker kill loses the entire drain (clips
// redeliver — at-least-once, deduped by nb.clipSeen) or none of it.

import { newClipId, normalizeClip } from '@nff-brain/core/clip';
import type { ClipRecord } from '@nff-brain/core/clip';
import { buildClipPrompt, parseClipResponse } from '@nff-brain/core/clipDistill';
import { applyClips, MAX_CLIP_NODES, MAX_PAGEVISIT_NODES, pruneClips } from '@nff-brain/core/clipApply';
import { isClipTierNode } from '@nff-brain/core/types';
import { applyClipMap, markDelivery } from './activity.js';
import { flashCaptured } from './badge.js';
import { readLocalBrain, runExclusive } from './brainStore.js';
import type { ClipPayload } from './client.js';
import { resolveBrainMode } from './mode.js';
import { makeProviderOneShot } from './providerClient.js';
import {
  CLIP_QUEUE_MAX,
  CLIP_SEEN_MAX,
  DEFAULT_DRAIN,
  PAGEVISIT_DAILY_DRAIN_CAP,
  PAGEVISIT_QUEUE_MAX,
} from './schema.js';
import type { PageVisitBudget } from './schema.js';
import {
  commitDrain,
  getActivity,
  getBrain,
  getClipQueue,
  getClipSeen,
  getDrainState,
  getPageVisitBudget,
  getPageVisitQueue,
  setClipQueue,
  setDrainState,
  setPageVisitQueue,
} from './storage.js';

export const DRAIN_ALARM = 'nb.drainClips';
export const MAX_CLIPS_PER_DRAIN = 25;

/** Same ladder shape as health.ts's probe backoff: 1/2/5/10/15 minutes. */
export const DRAIN_INTERVALS_MS = [60_000, 120_000, 300_000, 600_000, 900_000] as const;

export function nextDrainDelayMs(consecutiveFailures: number): number {
  const i = Math.min(Math.max(consecutiveFailures, 1), DRAIN_INTERVALS_MS.length) - 1;
  return DRAIN_INTERVALS_MS[i]!;
}

export async function ensureDrainAlarm(): Promise<void> {
  try {
    const existing = await chrome.alarms.get(DRAIN_ALARM);
    if (!existing) await chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: 1 });
  } catch {
    /* alarms API unavailable during teardown */
  }
}

export async function clearDrainAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(DRAIN_ALARM);
  } catch {
    /* best effort */
  }
}

/** Pure batch planning: fresh (unseen) clips only, capped. Exported for tests. */
export function planDrainBatch(queue: readonly ClipRecord[], seen: readonly string[]): ClipRecord[] {
  const seenSet = new Set(seen);
  return queue.filter((r) => !seenSet.has(r.id)).slice(0, MAX_CLIPS_PER_DRAIN);
}

/**
 * The standalone sibling of capture.ts's postClip tail. The gate/dedupe ran
 * already (capture.ts / recorder.ts are the only shouldCapture callers); this
 * is delivery only. Queues even in 'unconfigured' mode — a clip captured
 * before the user picked a setup path must not be lost.
 */
export async function enqueueStandaloneClip(payload: ClipPayload, activityId: string): Promise<boolean> {
  const nowMs = Date.now();
  const record = normalizeClip(
    { kind: payload.kind, text: payload.text, url: payload.url, title: payload.title },
    {
      id: newClipId(nowMs, crypto.randomUUID().slice(0, 6)),
      at: new Date(nowMs).toISOString(),
      target: 'global',
      source: 'chrome-standalone',
    },
  );
  if (!record) {
    await markDelivery(activityId, 'failed');
    await flashCaptured(false);
    return false;
  }

  const accepted = await runExclusive(async () => {
    const queue = await getClipQueue();
    // Mirror of the server's 507: a full queue refuses loudly, never rotates —
    // a clip is unlanded user intent.
    if (queue.length >= CLIP_QUEUE_MAX) return false;
    await setClipQueue([...queue, record]);
    return true;
  });

  await markDelivery(activityId, accepted ? 'delivered' : 'failed', accepted ? record.id : undefined);
  await flashCaptured(accepted);
  if (accepted) await ensureDrainAlarm();
  return accepted;
}

/**
 * The passive sibling of enqueueStandaloneClip, for pageVisitCapture.ts. Its
 * own queue (nb.pageVisitQueue) RING-DROPS the oldest entry instead of
 * refusing — visits are frequent and not an explicit user action, so a
 * chatty browsing day must never start rejecting real "Remember this" clicks
 * by sharing the clip queue's refuse-when-full behavior. No flashCaptured —
 * passive capture stays silent, no badge noise on every navigation.
 */
export async function enqueuePageVisit(
  payload: { text: string; url: string; title: string },
  activityId: string,
): Promise<boolean> {
  const nowMs = Date.now();
  const record = normalizeClip(
    { kind: 'pagevisit', text: payload.text, url: payload.url, title: payload.title },
    {
      id: newClipId(nowMs, crypto.randomUUID().slice(0, 6)),
      at: new Date(nowMs).toISOString(),
      target: 'global',
      source: 'chrome-standalone',
    },
  );
  if (!record) {
    await markDelivery(activityId, 'failed');
    return false;
  }

  await runExclusive(async () => {
    const queue = await getPageVisitQueue();
    await setPageVisitQueue([...queue, record].slice(-PAGEVISIT_QUEUE_MAX));
  });

  await markDelivery(activityId, 'delivered', record.id);
  await ensureDrainAlarm();
  return true;
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface StandaloneDrainResult {
  created: string[];
  processed: number;
  leftQueued: number;
}

const EMPTY: StandaloneDrainResult = { created: [], processed: 0, leftQueued: 0 };

/** The alarm handler body. Every precondition is re-read from disk here. */
export async function drainStandaloneClips(): Promise<StandaloneDrainResult> {
  if ((await resolveBrainMode()) !== 'byok') return EMPTY;

  const [queue, pageVisitQueue] = await Promise.all([getClipQueue(), getPageVisitQueue()]);
  if (queue.length === 0 && pageVisitQueue.length === 0) {
    await clearDrainAlarm();
    return EMPTY;
  }

  const drain = await getDrainState();
  if (Date.now() < drain.nextDrainAtMs) return EMPTY;

  // No key yet → clips simply wait; nothing is lost before setup.
  const oneShot = await makeProviderOneShot('background');
  if (!oneShot) return EMPTY;

  const seen = await getClipSeen();
  // Explicit clips always win the shared per-tick cap; page visits only fill
  // whatever room is left, further bounded by the daily distill budget (the
  // cost gate — nothing stops the QUEUE from growing, only what gets drained).
  const explicitBatch = planDrainBatch(queue, seen);
  const budget = await getPageVisitBudget();
  const today = todayKey();
  const headroom = budget.day === today ? Math.max(0, PAGEVISIT_DAILY_DRAIN_CAP - budget.drained) : PAGEVISIT_DAILY_DRAIN_CAP;
  const visitRoom = Math.max(0, MAX_CLIPS_PER_DRAIN - explicitBatch.length);
  const visitBatch = planDrainBatch(pageVisitQueue, seen).slice(0, Math.min(headroom, visitRoom));
  const batch = [...explicitBatch, ...visitBatch];

  if (batch.length === 0) {
    // Everything queued was already processed (a torn earlier commit), or the
    // daily page-visit budget is exhausted for now — either way, clean the
    // seen-ring debris out of both queues without spending an LLM call.
    await runExclusive(async () => {
      const seenSet = new Set(await getClipSeen());
      const q = await getClipQueue();
      const pv = await getPageVisitQueue();
      await setClipQueue(q.filter((r) => !seenSet.has(r.id)));
      await setPageVisitQueue(pv.filter((r) => !seenSet.has(r.id)));
    });
    return EMPTY;
  }

  const brain = await readLocalBrain();
  const knownClipNodes = brain.nodes
    .filter(isClipTierNode)
    .map((n) => ({ id: n.id, title: n.title, sourceUrl: n.sourceUrl }));

  let raw: string;
  try {
    raw = await oneShot(buildClipPrompt({ clips: batch, knownClipNodes }));
  } catch {
    // FAIL-OPEN: leave everything queued, back off. An auth failure was already
    // flagged into settings.lastTest by providerClient. The budget is untouched
    // — a failed attempt must not cost the day's allowance.
    await bumpBackoff();
    return { ...EMPTY, leftQueued: queue.length + pageVisitQueue.length };
  }

  const parsed = parseClipResponse(raw, batch);
  if (!parsed) {
    await bumpBackoff();
    return { ...EMPTY, leftQueued: queue.length + pageVisitQueue.length };
  }

  const explicitIds = new Set(explicitBatch.map((r) => r.id));
  const visitIds = new Set(visitBatch.map((r) => r.id));
  const clipsById = new Map(batch.map((r) => [r.id, r]));

  const result = await runExclusive(async () => {
    // Re-read INSIDE the chain — a retract may have landed since the LLM call.
    const current = (await getBrain()) ?? brain;
    const applied = applyClips(current, parsed.proposals, parsed.duplicates, clipsById);
    // Each origin has its own budget — a chatty browsing day can never crowd
    // out nodes the user explicitly asked to remember.
    const evicted = new Set([...pruneClips(current, MAX_CLIP_NODES, 'clip'), ...pruneClips(current, MAX_PAGEVISIT_NODES, 'pagevisit')]);
    current.updatedAt = new Date().toISOString();

    // `nodeIds: []` = processed, judged worthless — still deduped by the ring.
    const activity = await getActivity();
    const entries = batch.map((r) => ({
      clipId: r.id,
      nodeIds: (applied.byClip.get(r.id) ?? []).filter((id) => !evicted.has(id)),
    }));
    const { records } = applyClipMap(activity, entries);

    const remaining = (await getClipQueue()).filter((r) => !explicitIds.has(r.id));
    const remainingVisits = (await getPageVisitQueue()).filter((r) => !visitIds.has(r.id));
    const seenNext = [...batch.map((r) => r.id), ...(await getClipSeen())].slice(0, CLIP_SEEN_MAX);
    const nextBudget: PageVisitBudget = {
      day: today,
      drained: (budget.day === today ? budget.drained : 0) + visitBatch.length,
    };

    await commitDrain({
      brain: current,
      queue: remaining,
      seen: seenNext,
      activity: records,
      drain: DEFAULT_DRAIN,
      pageVisitQueue: remainingVisits,
      pageVisitBudget: nextBudget,
    });
    return {
      created: applied.created,
      processed: batch.length,
      leftQueued: remaining.length + remainingVisits.length,
    };
  });

  if (result.leftQueued === 0) await clearDrainAlarm();
  return result;
}

async function bumpBackoff(): Promise<void> {
  const drain = await getDrainState();
  const failures = drain.consecutiveFailures + 1;
  await setDrainState({ consecutiveFailures: failures, nextDrainAtMs: Date.now() + nextDrainDelayMs(failures) });
}
