import { describe, expect, it } from 'vitest';
import { DRAIN_INTERVALS_MS, MAX_CLIPS_PER_DRAIN, nextDrainDelayMs, planDrainBatch } from '../src/standaloneDrain.js';
import { deriveExtensionMode } from '../src/mode.js';
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

describe('deriveExtensionMode', () => {
  it('a stored pairing always wins, even with a key configured', () => {
    expect(deriveExtensionMode(true, true)).toBe('paired');
    expect(deriveExtensionMode(true, false)).toBe('paired');
  });

  it('standalone only when unpaired with a key; unconfigured otherwise', () => {
    expect(deriveExtensionMode(false, true)).toBe('standalone');
    expect(deriveExtensionMode(false, false)).toBe('unconfigured');
  });
});

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
