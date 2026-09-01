import { describe, expect, it } from 'vitest';
import type { LayoutEdge } from '../src/layout.js';
import { buildDensityClusters, isDensityClusterId, type DensityInputNode } from '../src/density.js';

function node(id: string, extra: Partial<DensityInputNode> = {}): DensityInputNode {
  return { id, title: id, category: 'strategy', x: 0, y: 0, size: 16, ...extra };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

/** A connected chain of `n` same-category nodes, packed `gap` apart on a line. */
function chain(prefix: string, n: number, category: string, gap: number) {
  const nodes: DensityInputNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(node(`${prefix}${i}`, { category, x: i * gap, y: 0 }));
    if (i > 0) edges.push(edge(`${prefix}${i - 1}`, `${prefix}${i}`));
  }
  return { nodes, edges };
}

function scattered(prefix: string, n: number, category = 'preference'): DensityInputNode[] {
  return Array.from({ length: n }, (_, i) => node(`${prefix}${i}`, { category, x: i * 10_000, y: i * 10_000 }));
}

describe('buildDensityClusters', () => {
  it('groups a same-category connected AND crowded blob', () => {
    // default radius 90 easily covers a gap of 5 — same metric as nff-admin's
    // density-heatmap blobs (DEFAULT_DENSITY_SCREEN_RADIUS).
    const blob = chain('blob', 20, 'strategy', 5);
    const clusters = buildDensityClusters(blob.nodes, blob.edges);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].category).toBe('strategy');
    expect(new Set(clusters[0].memberIds)).toEqual(new Set(blob.nodes.map((n) => n.id)));
    expect(isDensityClusterId(clusters[0].id)).toBe(true);
  });

  it('does NOT cluster a same-category connected chain the layout has spread out', () => {
    // Same topology as the blob above — same edges, same category — but each
    // node sits 1000 units from its neighbour, far past the default 90-unit
    // radius. Graph-connected is not the same thing as dense.
    const spread = chain('spread', 20, 'strategy', 1000);
    expect(buildDensityClusters(spread.nodes, spread.edges)).toEqual([]);
  });

  it('collapses only the crowded pocket of an otherwise spread-out same-category group', () => {
    // One tight pocket of 5 (gap 5) chained onto a long spread-out tail (gap
    // 1000) — all one connected component, all one category. Only the pocket
    // is dense enough to collapse; the spread tail stays as individual nodes.
    const pocket = chain('pocket', 5, 'strategy', 5);
    const tailNodes: DensityInputNode[] = [];
    const tailEdges: LayoutEdge[] = [];
    let prev = 'pocket4';
    for (let i = 0; i < 15; i++) {
      const id = `tail${i}`;
      tailNodes.push(node(id, { category: 'strategy', x: 1000 + i * 1000, y: 0 }));
      tailEdges.push(edge(prev, id));
      prev = id;
    }
    const nodes = [...pocket.nodes, ...tailNodes];
    const edges = [...pocket.edges, ...tailEdges];
    const clusters = buildDensityClusters(nodes, edges);

    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0].memberIds)).toEqual(new Set(pocket.nodes.map((n) => n.id)));
  });

  it('leaves crowded groups smaller than minClusterSize as ordinary nodes', () => {
    const small = chain('small', 3, 'strategy', 5); // crowded, but below default minClusterSize of 4
    expect(buildDensityClusters(small.nodes, small.edges)).toEqual([]);
  });

  it('never merges across categories, even when directly connected and crowded', () => {
    const a = chain('a', 15, 'strategy', 5);
    const b = chain('b', 15, 'analysis', 5);
    const bridge: LayoutEdge = edge('a14', 'b0');
    const nodes = [...a.nodes, ...b.nodes.map((n) => ({ ...n, x: n.x + 100, y: n.y }))]; // adjacent, still crowded
    const clusters = buildDensityClusters(nodes, [...a.edges, ...b.edges, bridge]);

    expect(clusters).toHaveLength(2);
    const cats = clusters.map((c) => c.category).sort();
    expect(cats).toEqual(['analysis', 'strategy']);
    for (const c of clusters) expect(c.memberIds).toHaveLength(15);
  });

  it('is a no-op on a small, sparse graph regardless of total node count', () => {
    // No global size gate any more — density is purely local/spatial. A
    // scattered graph of any size produces no clusters.
    const nodes = scattered('n', 80);
    expect(buildDensityClusters(nodes, [])).toEqual([]);
  });

  it('is deterministic across repeat calls', () => {
    const blob = chain('blob', 20, 'strategy', 5);
    const first = buildDensityClusters(blob.nodes, blob.edges);
    const second = buildDensityClusters(blob.nodes, blob.edges);
    expect(second).toEqual(first);
  });

  it('respects a custom radius — the same knob a caller resolves from its own zoom', () => {
    const blob = chain('blob', 5, 'strategy', 100); // gap 100
    expect(buildDensityClusters(blob.nodes, blob.edges)).toEqual([]); // default radius 90 < gap 100
    const clusters = buildDensityClusters(blob.nodes, blob.edges, { radius: 150 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toHaveLength(5);
  });

  it('respects a custom minClusterSize', () => {
    const blob = chain('blob', 3, 'strategy', 5);
    expect(buildDensityClusters(blob.nodes, blob.edges)).toEqual([]); // below default minClusterSize of 4
    const clusters = buildDensityClusters(blob.nodes, blob.edges, { minClusterSize: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toHaveLength(3);
  });

  it('tags nearBigNodeId when a cluster centroid lands within radius of a core node', () => {
    const blob = chain('blob', 20, 'strategy', 5); // centroid near x=47.5, y=0
    const core = node('hub', { category: 'core', x: 50, y: 0, size: 32 });
    const clusters = buildDensityClusters([...blob.nodes, core], blob.edges);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].nearBigNodeId).toBe('hub');
  });

  it('leaves nearBigNodeId null when no core node is within radius', () => {
    const blob = chain('blob', 20, 'strategy', 5);
    const farCore = node('hub', { category: 'core', x: 10_000, y: 0, size: 32 });
    const clusters = buildDensityClusters([...blob.nodes, farCore], blob.edges);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].nearBigNodeId).toBeNull();
  });
});
