import { describe, expect, it } from 'vitest';
import {
  DRAIN_INTERVALS_MS,
  MAX_CLIPS_PER_DRAIN,
  nextDrainDelayMs,
  planDrainBatch,
  planPageVisitBatch,
  todayKey,
} from '../src/standaloneDrain.js';
import { PAGEVISIT_DAILY_DRAIN_CAP } from '../src/schema.js';
import type { PageVisitBudget } from '../src/schema.js';
import type { ClipRecord } from '@nff-brain/core/clip';

// Pure halves only — the fetch/storage sides are covered by the structural
// suites (bundlePurity) plus the README's manual standalone checklist.

function clip(id: string): ClipRecord {
  return {
    v: 1,
    id,
    at: new Date(0).toISOString(),
    kind: 'selection',
    text: `text of ${id}`,
    target: 'global',
    source: 'chrome-standalone',
  } as ClipRecord;
}

// The mode resolver's matrix lives in mode.test.ts (deriveBrainMode) — the
// drain now gates on resolveBrainMode() === 'byok'.

describe('planDrainBatch', () => {
  it('filters seen ids and preserves queue order', () => {
    const queue = [clip('a'), clip('b'), clip('c')];
    expect(planDrainBatch(queue, ['b']).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('caps the batch at MAX_CLIPS_PER_DRAIN', () => {
    const queue = Array.from({ length: MAX_CLIPS_PER_DRAIN + 10 }, (_, i) => clip(`c${i}`));
    const batch = planDrainBatch(queue, []);
    expect(batch).toHaveLength(MAX_CLIPS_PER_DRAIN);
    expect(batch[0]!.id).toBe('c0');
  });

  it('returns empty when everything queued was already processed', () => {
    const queue = [clip('a'), clip('b')];
    expect(planDrainBatch(queue, ['a', 'b'])).toEqual([]);
  });
});

describe('nextDrainDelayMs', () => {
  it('walks the ladder and clamps at the top', () => {
    expect(nextDrainDelayMs(1)).toBe(DRAIN_INTERVALS_MS[0]);
    expect(nextDrainDelayMs(3)).toBe(DRAIN_INTERVALS_MS[2]);
    expect(nextDrainDelayMs(99)).toBe(DRAIN_INTERVALS_MS[DRAIN_INTERVALS_MS.length - 1]);
    // 0 failures is still a defined (immediate-retry-ish) delay, never NaN
    expect(nextDrainDelayMs(0)).toBe(DRAIN_INTERVALS_MS[0]);
  });
});

describe('todayKey', () => {
  it('is a stable YYYY-MM-DD for the same instant', () => {
    expect(todayKey(new Date('2026-03-05T23:59:00.000Z'))).toBe('2026-03-05');
  });
});

describe('planPageVisitBatch', () => {
  const freshBudget: PageVisitBudget = { day: '2026-03-05', drained: 0 };

  it('fills whatever room the explicit batch left in the shared per-tick cap', () => {
    const queue = Array.from({ length: 10 }, (_, i) => clip(`v${i}`));
    const batch = planPageVisitBatch(queue, [], MAX_CLIPS_PER_DRAIN - 3, freshBudget, '2026-03-05');
    expect(batch).toHaveLength(3);
  });

  it('takes nothing when the explicit batch already filled the per-tick cap', () => {
    const queue = [clip('v0')];
    expect(planPageVisitBatch(queue, [], MAX_CLIPS_PER_DRAIN, freshBudget, '2026-03-05')).toEqual([]);
  });

  it('is bounded by the remaining daily budget, not just the per-tick cap', () => {
    const queue = Array.from({ length: 10 }, (_, i) => clip(`v${i}`));
    const budget: PageVisitBudget = { day: '2026-03-05', drained: PAGEVISIT_DAILY_DRAIN_CAP - 2 };
    const batch = planPageVisitBatch(queue, [], 0, budget, '2026-03-05');
    expect(batch).toHaveLength(2);
  });

  it('takes nothing once the daily budget is exhausted', () => {
    const queue = [clip('v0')];
    const budget: PageVisitBudget = { day: '2026-03-05', drained: PAGEVISIT_DAILY_DRAIN_CAP };
    expect(planPageVisitBatch(queue, [], 0, budget, '2026-03-05')).toEqual([]);
  });

  it('resets to the full cap once the day rolls over', () => {
    const queue = [clip('v0')];
    const stale: PageVisitBudget = { day: '2026-03-04', drained: PAGEVISIT_DAILY_DRAIN_CAP };
    expect(planPageVisitBatch(queue, [], 0, stale, '2026-03-05')).toEqual([clip('v0')]);
  });

  it('excludes already-seen ids like planDrainBatch', () => {
    const queue = [clip('v0'), clip('v1')];
    expect(planPageVisitBatch(queue, ['v0'], 0, freshBudget, '2026-03-05').map((r) => r.id)).toEqual(['v1']);
  });
});
