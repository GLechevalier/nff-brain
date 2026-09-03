import { describe, expect, it } from 'vitest';
import type { LayoutEdge } from '../src/layout.js';
import {
  buildDensityClusters,
  isDensityClusterId,
  blobSize,
  MERGE_SCREEN_SLACK,
  type DensityInputNode,
} from '../src/density.js';

function node(id: string, extra: Partial<DensityInputNode> = {}): DensityInputNode {
  return { id, title: id, category: 'strategy', x: 0, y: 0, size: 16, ...extra };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

// Two size-16 squares overlap horizontally when |dx| < 16+16 = 32 (plus slack);
// vertically the label strip adds 14. All fixtures below sit on y=0 so the
// horizontal test is the deciding one.

describe('buildDensityClusters (overlap merging)', () => {
  it('merges two stacked nodes into one blob and leaves a separated pair alone', () => {
    const stacked = [node('a', { x: 0 }), node('b', { x: 10 })];
    const apart = [node('c', { x: 1000 }), node('d', { x: 2000 })];
    const clusters = buildDensityClusters([...stacked, ...apart], []);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(['a', 'b']);
    expect(isDensityClusterId(clusters[0].id)).toBe(true);
  });

  it('does not merge nodes separated by more than the slack', () => {
    // Gap between edges: |dx| - (sa+sb) = 40 - 32 = 8.
    const nodes = [node('a', { x: 0 }), node('b', { x: 40 })];
    expect(buildDensityClusters(nodes, [])).toEqual([]); // slack 0: 8px clear
    expect(buildDensityClusters(nodes, [], { slack: 10 })).toHaveLength(1); // slack 10 covers it
  });

  it('merges transitively: a chain of pairwise overlaps becomes ONE blob', () => {
    // a∩b, b∩c, but a and c are 60 apart (no direct overlap).
    const nodes = [node('a', { x: 0 }), node('b', { x: 30 }), node('c', { x: 60 })];
    const clusters = buildDensityClusters(nodes, []);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  it('merges across categories — the trigger is purely visual', () => {
    const nodes = [
      node('a', { category: 'strategy', x: 0 }),
      node('b', { category: 'analysis', x: 10 }),
      node('c', { category: 'rules', x: 20 }),
    ];
    const clusters = buildDensityClusters(nodes, []);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(['a', 'b', 'c']);
    // Dominant category with a 1/1/1 tie falls back to the anchor's own.
    expect(clusters[0].category).toBe(nodes.find((n) => n.id === clusters[0].anchorId)!.category);
  });

  it('anchors on the largest member (ties → lowest id) and grows it by blobSize', () => {
    const nodes = [node('small', { x: 0, size: 16 }), node('hub', { x: 20, size: 32 }), node('tiny', { x: 40, size: 10 })];
    const clusters = buildDensityClusters(nodes, []);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].anchorId).toBe('hub');
    // Area-conserving growth: sqrt(32² + 16² + 10²) — visibly bigger than the
    // base 32, proportional to what was actually swallowed.
    expect(clusters[0].size).toBe(blobSize(32, [16, 10]));
    expect(clusters[0].size).toBeCloseTo(Math.sqrt(32 * 32 + 16 * 16 + 10 * 10));

    const tied = buildDensityClusters([node('b', { x: 0 }), node('a', { x: 10 })], []);
    expect(tied[0].anchorId).toBe('a');
  });

  it('chain-eats: a grown blob absorbs a node its base anchor never touched', () => {
    // a(size 16)∩b at x=0/20; anchor a grows to 16+sqrt(1)*4 = 20 — now its
    // edge reaches x=20... c sits at x=38: 38 < 20+16 = 36? No — place c so
    // it overlaps ONLY the grown anchor: base a+c test |38| < 16+16 = 32 (no),
    // grown |38| < 20+16 = 36 (no)... use 35: base no (35>32), grown yes (35<36).
    const nodes = [node('a', { x: 0 }), node('b', { x: 20 }), node('c', { x: 35 })];
    const clusters = buildDensityClusters(nodes, []);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic and input-order independent', () => {
    const nodes = [
      node('n1', { x: 0 }),
      node('n2', { x: 15 }),
      node('n3', { x: 500 }),
      node('n4', { x: 512, size: 20 }),
      node('n5', { x: 5000 }),
    ];
    const a = buildDensityClusters(nodes, [edge('n1', 'n2')]);
    const b = buildDensityClusters([...nodes].reverse(), []);
    expect(a).toEqual(b);
    expect(a.map((c) => c.memberIds)).toEqual([
      ['n1', 'n2'],
      ['n3', 'n4'],
    ]);
    expect(a.map((c) => c.anchorId)).toEqual(['n1', 'n4']);
    // No priority map ≡ an empty one: everything ranks as absorbable.
    expect(buildDensityClusters(nodes, [], { priority: new Map() })).toEqual(a);
  });

  it('coalesces more as the caller dezooms (bigger slack)', () => {
    // 100 apart: untouched at slack 0, one blob at fit-zoom-like slack.
    const nodes = [node('a', { x: 0 }), node('b', { x: 100 })];
    expect(buildDensityClusters(nodes, [], { slack: 0 })).toEqual([]);
    expect(buildDensityClusters(nodes, [], { slack: MERGE_SCREEN_SLACK / 0.15 })).toHaveLength(1);
  });

  it('summarises extractively and prefixes ids with density:', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`m${i}`, { x: i * 5 }));
    const [c] = buildDensityClusters(nodes, []);
    expect(c.id.startsWith('density:')).toBe(true);
    expect(c.summary).toContain('6 nodes');
    expect(c.summary).toContain('m0');
    expect(c.summary).toContain('+2 more');
  });

  it('returns [] for empty and single-node graphs', () => {
    expect(buildDensityClusters([], [])).toEqual([]);
    expect(buildDensityClusters([node('only')], [])).toEqual([]);
  });

  it('a protected (priority 2) node anchors its blob even when a bigger member overlaps it', () => {
    // Without priority the size-40 node would anchor and hide the tab
    // master; ranked 2, the master wins the anchor pick and stays visible.
    const nodes = [node('tab-master', { x: 0, size: 20 }), node('big', { x: 30, size: 40 })];
    const [c] = buildDensityClusters(nodes, [], { priority: new Map([['tab-master', 2]]) });
    expect(c.anchorId).toBe('tab-master');
    expect(c.memberIds).toEqual(['big', 'tab-master']);
  });

  it('two protected nodes never merge with each other, even bridged by a plain node', () => {
    // hub∩mid and mid∩tool at equal distance and equal rank: the bridge joins
    // ONE of them (lowest id), and both protected nodes stay visible.
    const nodes = [
      node('hub', { x: 0, size: 20 }),
      node('mid', { x: 35, size: 16 }),
      node('tool', { x: 70, size: 20 }),
    ];
    const clusters = buildDensityClusters(nodes, [], { priority: new Map([['hub', 2], ['tool', 2]]) });
    const hidden = new Set(clusters.flatMap((c) => c.memberIds.filter((id) => id !== c.anchorId)));
    expect(hidden.has('hub')).toBe(false);
    expect(hidden.has('tool')).toBe(false);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(['hub', 'mid']);
  });

  it('two overlapping protected nodes produce no blob at all', () => {
    const nodes = [node('hub', { x: 0 }), node('tool', { x: 10 })];
    expect(buildDensityClusters(nodes, [], { priority: new Map([['hub', 2], ['tool', 2]]) })).toEqual([]);
  });

  it('priority beats distance: a plain node closer to a tool still joins the hub', () => {
    // mid is 30 from the hub and 20 from the tool — both overlap it. Rank 1
    // wins over rank 2 regardless of distance (and of id order: today's
    // sorted scan would have paired it with 'a-tool').
    const nodes = [
      node('hub', { x: 0, size: 20 }),
      node('mid', { x: 30 }),
      node('a-tool', { x: 50, size: 20 }),
    ];
    const clusters = buildDensityClusters(nodes, [], { priority: new Map([['hub', 1], ['a-tool', 2]]) });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].anchorId).toBe('hub');
    expect(clusters[0].memberIds).toEqual(['hub', 'mid']);
  });

  it('equal priority → the closest anchor wins', () => {
    const nodes = [
      node('tool-a', { x: 0, size: 20 }),
      node('tool-b', { x: 50, size: 20 }),
      node('mid', { x: 30 }),
    ];
    const clusters = buildDensityClusters(nodes, [], { priority: new Map([['tool-a', 2], ['tool-b', 2]]) });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].anchorId).toBe('tool-b');
    expect(clusters[0].memberIds).toEqual(['mid', 'tool-b']);
  });

  it('plain nodes pair with their closest neighbour, not everything they touch', () => {
    // b overlaps a (25) and c (30); c overlaps b (30) and d (25). Each joins
    // its closest → two blobs, where connected components would give one.
    // The grown anchors (25.6 at x=0 and x=80) do not overlap, so it holds.
    const nodes = [
      node('a', { x: 0, size: 20 }),
      node('b', { x: 25 }),
      node('c', { x: 55 }),
      node('d', { x: 80, size: 20 }),
    ];
    const clusters = buildDensityClusters(nodes, []);
    expect(clusters.map((c) => c.memberIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(clusters.map((c) => c.anchorId)).toEqual(['a', 'd']);
  });

  it('pickAnchor ranks priority over size', () => {
    const nodes = [node('hub', { x: 0 }), node('big', { x: 10, size: 40 }), node('small', { x: 20, size: 10 })];
    const [c] = buildDensityClusters(nodes, [], { priority: new Map([['hub', 1]]) });
    expect(c.anchorId).toBe('hub');
    expect(c.memberIds).toEqual(['big', 'hub', 'small']);
    expect(c.size).toBe(blobSize(16, [40, 10]));
  });
});
