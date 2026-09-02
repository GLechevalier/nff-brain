import { describe, expect, it } from 'vitest';
import {
  applyClipMap,
  planVisit,
  siteLabel,
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

describe('page-visit log', () => {
  const tab = (url: string, extra: Partial<{ title: string; status: string }> = {}) => ({ url, title: 'Feed | LinkedIn', status: 'complete', ...extra });

  it('labels known brands and capitalises the rest', () => {
    expect(siteLabel('www.linkedin.com')).toBe('LinkedIn');
    expect(siteLabel('en.wikipedia.org')).toBe('Wikipedia');
    expect(siteLabel('mail.google.com')).toBe('Google');
    expect(siteLabel('nanoforgeflow.com')).toBe('Nanoforgeflow');
    expect(siteLabel('')).toBe('');
  });

  it('appends on a completed http(s) load, never for chrome:// or extension pages', () => {
    const plan = planVisit({ status: 'complete' }, tab('https://www.linkedin.com/feed/'), undefined);
    expect(plan?.kind).toBe('append');
    if (plan?.kind !== 'append') throw new Error('expected append');
    expect(plan.item.title).toBe('Navigated to LinkedIn — Feed | LinkedIn');
    expect(plan.item.text).toBe('page-visit\nhttps://www.linkedin.com/feed/');
    expect(plan.item.delivery).toBe('delivered');
    expect(planVisit({ status: 'complete' }, tab('chrome://extensions'), undefined)).toBeNull();
    expect(planVisit({ status: 'complete' }, tab('chrome-extension://abc/sidepanel.html'), undefined)).toBeNull();
    // A plain loading tick logs nothing — the title isn't known yet.
    expect(planVisit({ status: 'loading', url: 'https://x.com/' }, tab('https://x.com/', { status: 'loading' }), undefined)).toBeNull();
  });

  it('does not re-log a reload of the newest visit, but still logs a different page', () => {
    const newest = rec('v', { url: 'https://www.linkedin.com/feed/', text: 'page-visit\nhttps://www.linkedin.com/feed/' });
    expect(planVisit({ status: 'complete' }, tab('https://www.linkedin.com/feed/'), newest)).toBeNull();
    expect(planVisit({ status: 'complete' }, tab('https://www.linkedin.com/jobs/'), newest)?.kind).toBe('append');
    // A captured clip on the same url is not a visit — the visit still gets logged.
    const clip = rec('c', { url: 'https://www.linkedin.com/feed/', text: 'selected text' });
    expect(planVisit({ status: 'complete' }, tab('https://www.linkedin.com/feed/'), clip)?.kind).toBe('append');
  });

  it('handles SPA navigation: {url} on a complete tab appends, the later {title} retitles', () => {
    const first = planVisit({ url: 'https://www.linkedin.com/jobs/' }, tab('https://www.linkedin.com/jobs/', { title: 'Feed | LinkedIn' }), undefined);
    expect(first?.kind).toBe('append');
    const newest = rec('v', { url: 'https://www.linkedin.com/jobs/', text: 'page-visit\nhttps://www.linkedin.com/jobs/' });
    const retitle = planVisit({ title: 'Jobs | LinkedIn' }, tab('https://www.linkedin.com/jobs/', { title: 'Jobs | LinkedIn' }), newest);
    expect(retitle).toEqual({ kind: 'retitle', title: 'Navigated to LinkedIn — Jobs | LinkedIn' });
  });
});
