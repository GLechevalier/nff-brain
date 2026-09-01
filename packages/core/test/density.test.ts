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

  it('a protected node anchors its blob even when a bigger member overlaps it', () => {
    // Without protection the size-40 node would anchor and hide the tab
    // master; protected, the master wins the anchor pick and stays visible.
    const nodes = [node('tab-master', { x: 0, size: 20 }), node('big', { x: 30, size: 40 })];
    const [c] = buildDensityClusters(nodes, [], { protectedIds: new Set(['tab-master']) });
    expect(c.anchorId).toBe('tab-master');
    expect(c.memberIds).toEqual(['big', 'tab-master']);
  });

  it('two protected nodes never merge with each other, even bridged by a plain node', () => {
    // hub∩mid and mid∩tool: transitively one component — but that would hide
    // one protected node behind the other, so the union guard splits it: the
    // bridge joins ONE of them, and both protected nodes stay visible.
    const nodes = [
      node('hub', { x: 0, size: 20 }),
      node('mid', { x: 35, size: 16 }),
      node('tool', { x: 70, size: 20 }),
    ];
    const clusters = buildDensityClusters(nodes, [], { protectedIds: new Set(['hub', 'tool']) });
    const hidden = new Set(clusters.flatMap((c) => c.memberIds.filter((id) => id !== c.anchorId)));
    expect(hidden.has('hub')).toBe(false);
    expect(hidden.has('tool')).toBe(false);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toContain('mid');
  });

  it('two overlapping protected nodes produce no blob at all', () => {
    const nodes = [node('hub', { x: 0 }), node('tool', { x: 10 })];
    expect(buildDensityClusters(nodes, [], { protectedIds: new Set(['hub', 'tool']) })).toEqual([]);
  });
});
