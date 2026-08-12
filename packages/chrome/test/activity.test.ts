import { describe, expect, it } from 'vitest';
import {
  applyClipMap,
  hasUnresolvedClips,
  pushRecent,
  recentKey,
  removableNodeCount,
  seenRecently,
} from '../src/activity.js';
import { RECENT_MAX, RECENT_WINDOW_MS } from '../src/schema.js';
import type { ActivityRecord, RecentClip } from '../src/schema.js';

function rec(id: string, extra: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id,
    at: '2026-08-11T00:00:00.000Z',
    host: 'example.com',
    url: 'https://example.com/x',
    title: 'Example',
    text: 'captured',
    delivery: 'delivered',
    nodeIds: [],
    ...extra,
  };
}

describe('applyClipMap', () => {
  it('fills nodeIds by clipId and reports change', () => {
    const records = [rec('a', { clipId: 'clp_1' }), rec('b', { clipId: 'clp_2' }), rec('c')];
    const { records: next, changed } = applyClipMap(records, [
      { clipId: 'clp_1', nodeIds: ['node-x'] },
      { clipId: 'clp_9', nodeIds: ['unrelated'] },
    ]);
    expect(changed).toBe(true);
    expect(next[0].nodeIds).toEqual(['node-x']);
    expect(next[1].nodeIds).toEqual([]); // no mapping yet
    expect(removableNodeCount(next)).toBe(1);
  });

  it('never overwrites nodeIds already shown to the user, and empty maps are no-ops', () => {
    const records = [rec('a', { clipId: 'clp_1', nodeIds: ['already'] })];
    const { records: next, changed } = applyClipMap(records, [{ clipId: 'clp_1', nodeIds: ['other'] }]);
    expect(changed).toBe(false);
    expect(next[0].nodeIds).toEqual(['already']);
    // A worthless-clip entry (nodeIds: []) fills nothing either.
    const r2 = applyClipMap([rec('b', { clipId: 'clp_2' })], [{ clipId: 'clp_2', nodeIds: [] }]);
    expect(r2.changed).toBe(false);
  });

  it('hasUnresolvedClips is the poll gate: delivered clipId + empty nodeIds', () => {
    expect(hasUnresolvedClips([rec('a', { clipId: 'clp_1' })])).toBe(true);
    expect(hasUnresolvedClips([rec('a', { clipId: 'clp_1', nodeIds: ['n'] })])).toBe(false);
    expect(hasUnresolvedClips([rec('a')])).toBe(false); // never delivered → nothing to resolve
  });
});

describe('recent-capture dedupe ring', () => {
  const t0 = 1_000_000;

  it('dedupes an identical capture inside the window and admits it after', () => {
    const key = recentKey('selection', 'https://example.com', 'same text');
    let ring: RecentClip[] = pushRecent([], key, t0);
    expect(seenRecently(ring, key, t0 + 1000)).toBe(true);
    expect(seenRecently(ring, key, t0 + RECENT_WINDOW_MS + 1)).toBe(false);
    // A different kind/url/text is a different key.
    expect(seenRecently(ring, recentKey('page', 'https://example.com', 'same text'), t0 + 1000)).toBe(false);
    void ring;
  });

  it('caps the ring and drops expired entries on push', () => {
    let ring: RecentClip[] = [];
    for (let i = 0; i < RECENT_MAX + 10; i++) ring = pushRecent(ring, `key-${i}`, t0 + i);
    expect(ring.length).toBeLessThanOrEqual(RECENT_MAX);
    const expired: RecentClip[] = [{ key: 'old', atMs: t0 - RECENT_WINDOW_MS - 1 }];
    expect(pushRecent(expired, 'new', t0).some((r) => r.key === 'old')).toBe(false);
  });
});
