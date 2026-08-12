import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_GAP,
  LABEL_PAD,
  connectedComponents,
  layoutBrain,
  spaceOutNodes,
  type LayoutEdge,
  type LayoutNode,
  type Pt,
} from '../src/layout.js';

function node(id: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, x: 0, y: 0, size: 16, ...extra };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

/** A fully-connected triangle a-b-c under the given prefix. */
function triangle(prefix: string): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const ids = ['a', 'b', 'c'].map((s) => `${prefix}${s}`);
  return {
    nodes: ids.map((id) => node(id)),
    edges: [edge(ids[0], ids[1]), edge(ids[1], ids[2]), edge(ids[0], ids[2])],
  };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxOf(ids: readonly string[], pos: Record<string, Pt>, size = 16) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    minX = Math.min(minX, pos[id].x - size);
    minY = Math.min(minY, pos[id].y - size);
    maxX = Math.max(maxX, pos[id].x + size);
    maxY = Math.max(maxY, pos[id].y + size);
  }
  return { minX, minY, maxX, maxY };
}

describe('connectedComponents', () => {
  it('partitions two cliques and an isolate', () => {
    const t1 = triangle('x');
    const t2 = triangle('y');
    const nodes = [...t1.nodes, ...t2.nodes, node('lonely')];
    const comps = connectedComponents(nodes, [...t1.edges, ...t2.edges]);

    expect(comps.map((c) => c.length)).toEqual([3, 3, 1]);
    expect(comps.find((c) => c.includes('lonely'))).toEqual(['lonely']);
    // Members of one triangle never leak into the other.
    const withXa = comps.find((c) => c.includes('xa'))!;
    expect(withXa.sort()).toEqual(['xa', 'xb', 'xc']);
  });

  it('ignores edges pointing at nodes that are not in the graph', () => {
    const comps = connectedComponents([node('a'), node('b')], [edge('a', 'ghost'), edge('b', 'a')]);
    expect(comps).toEqual([['a', 'b']]);
  });

  it('orders deterministically: size desc, then smallest member id', () => {
    const nodes = [node('m'), node('z'), node('a'), node('b')];
    const edges = [edge('a', 'b')];
    const first = connectedComponents(nodes, edges);
    const shuffled = connectedComponents([...nodes].reverse(), edges);
    expect(first).toEqual(shuffled);
    expect(first[0]).toEqual(['a', 'b']);
  });

  it('handles a long chain without blowing the stack', () => {
    const n = 5000;
    const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    expect(connectedComponents(nodes, edges)).toHaveLength(1);
  });
});

describe('layoutBrain', () => {
  it('is deterministic — identical input yields identical output', () => {
    const t1 = triangle('x');
    const t2 = triangle('y');
    const nodes = [...t1.nodes, ...t2.nodes];
    const edges = [...t1.edges, ...t2.edges];
    expect(layoutBrain(nodes, edges)).toEqual(layoutBrain(nodes, edges));
  });

  it('pulls connected nodes together — barbell stays two lobes', () => {
    // Two triangles joined by ONE edge. Edge attraction must keep each lobe
    // tighter than the span between them; the old overlap-only pass could not
    // do this, because it had no attraction term at all.
    const t1 = triangle('x');
    const t2 = triangle('y');
    const edges = [...t1.edges, ...t2.edges, edge('xa', 'ya')];
    const pos = layoutBrain([...t1.nodes, ...t2.nodes], edges);

    const intra = [
      dist(pos.xa, pos.xb),
      dist(pos.xb, pos.xc),
      dist(pos.xa, pos.xc),
      dist(pos.ya, pos.yb),
      dist(pos.yb, pos.yc),
      dist(pos.ya, pos.yc),
    ];
    const meanIntra = intra.reduce((s, d) => s + d, 0) / intra.length;
    const across = dist(pos.xc, pos.yc); // the two far corners
    expect(meanIntra).toBeLessThan(across);
  });

  it('weights attraction by edge strength', () => {
    // A star where one spoke is strong and one is weak: the strong neighbour
    // must settle closer. This is what keeps weak same-session provenance
    // edges from dominating the picture.
    const nodes = [node('hub'), node('strong'), node('weak')];
    const edges = [edge('hub', 'strong', 1), edge('hub', 'weak', 0.2)];
    const pos = layoutBrain(nodes, edges);
    expect(dist(pos.hub, pos.strong)).toBeLessThan(dist(pos.hub, pos.weak));
  });

  it('separates disconnected components into disjoint boxes', () => {
    const t1 = triangle('x');
    const t2 = triangle('y');
    const gutter = 180;
    const pos = layoutBrain([...t1.nodes, ...t2.nodes], [...t1.edges, ...t2.edges], {
      componentGutter: gutter,
    });

    const b1 = boxOf(['xa', 'xb', 'xc'], pos);
    const b2 = boxOf(['ya', 'yb', 'yc'], pos);
    const overlapX = Math.min(b1.maxX, b2.maxX) - Math.max(b1.minX, b2.minX);
    const overlapY = Math.min(b1.maxY, b2.maxY) - Math.max(b1.minY, b2.minY);
    // Disjoint on at least one axis, and cleanly so.
    expect(Math.min(overlapX, overlapY)).toBeLessThan(0);
  });

  it('centres the board on the requested origin', () => {
    const t = triangle('x');
    const pos = layoutBrain(t.nodes, t.edges, { center: { x: 1000, y: 500 } });
    const b = boxOf(['xa', 'xb', 'xc'], pos);
    // LABEL_PAD is added to the bottom of every box, so the centre sits a
    // little above the geometric middle of the padded box.
    expect((b.minX + b.maxX) / 2).toBeCloseTo(1000, 0);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(500 - LABEL_PAD / 2, 0);
  });

  it('leaves no node pair overlapping', () => {
    const t1 = triangle('x');
    const t2 = triangle('y');
    const nodes = [...t1.nodes, ...t2.nodes, node('big', { size: 32 })];
    const edges = [...t1.edges, ...t2.edges, edge('big', 'xa')];
    const minGap = 60;
    const pos = layoutBrain(nodes, edges, { minGap });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const req = a.size + b.size + minGap + LABEL_PAD;
        expect(dist(pos[a.id], pos[b.id])).toBeGreaterThanOrEqual(req - 0.5);
      }
    }
  });

  it('returns an empty map for an empty graph', () => {
    expect(layoutBrain([], [])).toEqual({});
  });

  it('places a lone node at the centre', () => {
    const pos = layoutBrain([node('only')], [], { center: { x: 400, y: 300 } });
    expect(pos.only.x).toBeCloseTo(400, 0);
  });
});

describe('layoutBrain — radial tree along a spine', () => {
  // Root plus two disconnected pairs, linked by one grouping node.
  const nodes = [
    node('root', { size: 32 }),
    node('r1'),
    node('a1'),
    node('a2'),
    node('b1'),
    node('b2'),
  ];
  const edges = [edge('root', 'r1'), edge('a1', 'a2'), edge('b1', 'b2')];
  const spine = {
    rootId: 'root',
    nodes: [{ id: 'spine:1-0', level: 1, memberIds: ['a1', 'a2', 'b1', 'b2'], size: 22 }],
    edges: [
      edge('root', 'spine:1-0', 0.3),
      edge('spine:1-0', 'a1', 0.3),
      edge('spine:1-0', 'b1', 0.3),
    ],
  };

  it('puts the root at the centre and everything else outside it', () => {
    const center = { x: 400, y: 300 };
    const pos = layoutBrain(nodes, edges, { spine, center });
    // The root's own island is centred on the origin, so the root sits close to it.
    expect(dist(pos.root, center)).toBeLessThan(200);
    const spineR = dist(pos['spine:1-0'], center);
    for (const id of ['a1', 'a2', 'b1', 'b2']) {
      expect(dist(pos[id], center)).toBeGreaterThan(spineR);
    }
  });

  it('positions the grouping node itself', () => {
    const pos = layoutBrain(nodes, edges, { spine });
    expect(pos['spine:1-0']).toBeDefined();
    expect(Number.isFinite(pos['spine:1-0'].x)).toBe(true);
  });

  it('keeps each island together in its own wedge', () => {
    const pos = layoutBrain(nodes, edges, { spine });
    // Members of one island are closer to each other than to the other island.
    expect(dist(pos.a1, pos.a2)).toBeLessThan(dist(pos.a1, pos.b1));
    expect(dist(pos.b1, pos.b2)).toBeLessThan(dist(pos.b1, pos.a1));
  });

  it('leaves no overlaps, spine nodes included', () => {
    const minGap = 60;
    const pos = layoutBrain(nodes, edges, { spine, minGap });
    const all = [...nodes, { id: 'spine:1-0', x: 0, y: 0, size: 22 }];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const req = all[i].size + all[j].size + minGap + LABEL_PAD;
        expect(dist(pos[all[i].id], pos[all[j].id])).toBeGreaterThanOrEqual(req - 0.5);
      }
    }
  });

  it('is deterministic', () => {
    expect(layoutBrain(nodes, edges, { spine })).toEqual(layoutBrain(nodes, edges, { spine }));
  });

  it('ignores a spine whose root is not in the graph', () => {
    const orphanSpine = { ...spine, rootId: 'ghost' };
    const withGhost = layoutBrain(nodes, edges, { spine: orphanSpine });
    const withNone = layoutBrain(nodes, edges, {});
    // Falls back to island packing; spine nodes still get placed near members.
    for (const n of nodes) expect(withGhost[n.id]).toEqual(withNone[n.id]);
  });

  it('keeps stored positions in incremental mode and hangs the spine off them', () => {
    // A radial tree is global, so it must NOT re-arrange a settled board.
    const settled = nodes.map((n, i) => ({ ...n, x: 100 * i, y: 50 * i, laidOut: true }));
    const pos = layoutBrain(settled, edges, { spine, incremental: true });
    for (const n of settled) expect(pos[n.id]).toEqual({ x: n.x, y: n.y });
    expect(pos['spine:1-0']).toBeDefined();
  });
});

describe('layoutBrain — incremental', () => {
  it('never moves a node that is already laid out', () => {
    const settled: LayoutNode[] = [
      node('a', { x: 100, y: 100, laidOut: true }),
      node('b', { x: 300, y: 100, laidOut: true }),
      node('c', { x: 200, y: 300, laidOut: true }),
    ];
    const fresh = node('new', { x: 9999, y: 9999 }); // placeNode's random spot
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'new')];

    const pos = layoutBrain([...settled, fresh], edges, { incremental: true });
    for (const n of settled) {
      expect(pos[n.id]).toEqual({ x: n.x, y: n.y });
    }
  });

  it('seeds a new node beside its settled neighbour, not at its random spot', () => {
    const a = node('a', { x: 100, y: 100, laidOut: true });
    const fresh = node('new', { x: 9999, y: 9999 });
    const pos = layoutBrain([a, fresh], [edge('a', 'new')], { incremental: true });

    // It landed in the neighbourhood, nowhere near (9999, 9999)…
    expect(dist(pos.new, { x: 100, y: 100 })).toBeLessThan(400);
    // …but not on top of the neighbour. Derived from the default rather than
    // repeating the number, so re-tuning the spacing cannot silently break this.
    const req = a.size + fresh.size + DEFAULT_MIN_GAP + LABEL_PAD;
    expect(dist(pos.new, pos.a)).toBeGreaterThanOrEqual(req - 0.5);
  });

  it('parks an all-new component clear of the settled board', () => {
    const settled = [
      node('a', { x: 100, y: 100, laidOut: true }),
      node('b', { x: 200, y: 100, laidOut: true }),
    ];
    const island = [node('p'), node('q')];
    const pos = layoutBrain([...settled, ...island], [edge('a', 'b'), edge('p', 'q')], {
      incremental: true,
      componentGutter: 180,
    });
    // Parked to the right of the settled region rather than left on the random
    // coordinates placeNode handed out.
    expect(Math.min(pos.p.x, pos.q.x)).toBeGreaterThan(200);
  });

  it('falls back to a full pass when nothing is laid out yet', () => {
    // Honouring `incremental` on a virgin brain would leave every node on
    // placeNode's random coordinates — the hairball this module exists to fix.
    const t1 = triangle('x');
    const t2 = triangle('y');
    const nodes = [...t1.nodes, ...t2.nodes].map((n, i) =>
      // Random-ish starting coordinates, as placeNode would hand out.
      ({ ...n, x: 120 + i * 37, y: 100 + ((i * 91) % 400) }),
    );
    const edges = [...t1.edges, ...t2.edges];

    const incremental = layoutBrain(nodes, edges, { incremental: true });
    const fullPass = layoutBrain(nodes, edges, { incremental: false });
    expect(incremental).toEqual(fullPass);
  });

  it('is a no-op when everything is already laid out', () => {
    const nodes = [
      node('a', { x: 100, y: 100, laidOut: true }),
      node('b', { x: 400, y: 100, laidOut: true }),
    ];
    const pos = layoutBrain(nodes, [edge('a', 'b')], { incremental: true });
    expect(pos).toEqual({ a: { x: 100, y: 100 }, b: { x: 400, y: 100 } });
  });
});

describe('spaceOutNodes', () => {
  it('separates overlapping nodes to the required gap', () => {
    const nodes = [
      { id: 'a', x: 100, y: 100, size: 16 },
      { id: 'b', x: 105, y: 100, size: 16 },
    ];
    const pos = spaceOutNodes(nodes, { minGap: 24 });
    expect(dist(pos.a, pos.b)).toBeGreaterThanOrEqual(16 + 16 + 24 + LABEL_PAD - 0.5);
  });

  it('separates exactly coincident nodes deterministically', () => {
    const nodes = [
      { id: 'a', x: 50, y: 50, size: 16 },
      { id: 'b', x: 50, y: 50, size: 16 },
    ];
    const first = spaceOutNodes(nodes.map((n) => ({ ...n })), { minGap: 24 });
    const second = spaceOutNodes(nodes.map((n) => ({ ...n })), { minGap: 24 });
    expect(first).toEqual(second);
    expect(dist(first.a, first.b)).toBeGreaterThan(0);
  });

  it('never moves a pinned node', () => {
    const nodes = [
      { id: 'hub', x: 100, y: 100, size: 32 },
      { id: 'other', x: 102, y: 100, size: 16 },
    ];
    const pos = spaceOutNodes(nodes, { minGap: 24, pinnedId: 'hub' });
    expect(pos.hub).toEqual({ x: 100, y: 100 });
  });

  it('never moves a node in the pinned set', () => {
    const nodes = [
      { id: 'a', x: 100, y: 100, size: 16 },
      { id: 'b', x: 102, y: 100, size: 16 },
    ];
    const pos = spaceOutNodes(nodes, { minGap: 24, pinned: new Set(['a']) });
    expect(pos.a).toEqual({ x: 100, y: 100 });
    expect(pos.b.x).not.toBe(102);
  });

  it('leaves a single node alone', () => {
    const pos = spaceOutNodes([{ id: 'a', x: 7, y: 9, size: 16 }]);
    expect(pos.a).toEqual({ x: 7, y: 9 });
  });
});
