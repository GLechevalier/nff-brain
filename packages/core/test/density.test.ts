import { describe, expect, it } from 'vitest';
import type { LayoutEdge } from '../src/layout.js';
import { buildDensityClusters, isDensityClusterId, type DensityInputNode } from '../src/density.js';

function node(id: string, extra: Partial<DensityInputNode> = {}): DensityInputNode {
  return { id, title: id, category: 'strategy', ...extra };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

/** A connected chain of `n` same-category nodes. */
function chain(prefix: string, n: number, category: string) {
  const nodes: DensityInputNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(node(`${prefix}${i}`, { category }));
    if (i > 0) edges.push(edge(`${prefix}${i - 1}`, `${prefix}${i}`));
  }
  return { nodes, edges };
}

function scattered(prefix: string, n: number, category = 'preference'): DensityInputNode[] {
  return Array.from({ length: n }, (_, i) => node(`${prefix}${i}`, { category }));
}

describe('buildDensityClusters', () => {
  it('is a no-op at or below the threshold', () => {
    const nodes = scattered('n', 55);
    expect(buildDensityClusters(nodes, [])).toEqual([]);
  });

  it('groups a same-category connected blob once above the threshold', () => {
    const blob = chain('blob', 20, 'strategy');
    const singles = scattered('single', 40); // 40 + 20 = 60 > 55
    const nodes = [...blob.nodes, ...singles];
    const clusters = buildDensityClusters(nodes, blob.edges);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].category).toBe('strategy');
    expect(clusters[0].memberIds).toHaveLength(20);
    expect(new Set(clusters[0].memberIds)).toEqual(new Set(blob.nodes.map((n) => n.id)));
    expect(isDensityClusterId(clusters[0].id)).toBe(true);
  });

  it('leaves connected groups smaller than minClusterSize as ordinary nodes', () => {
    const small = chain('small', 3, 'strategy'); // below default minClusterSize of 4
    const singles = scattered('single', 53); // 53 + 3 = 56 > 55
    const nodes = [...small.nodes, ...singles];
    const clusters = buildDensityClusters(nodes, small.edges);
    expect(clusters).toEqual([]);
  });

  it('never merges across categories, even when directly connected', () => {
    const a = chain('a', 15, 'strategy');
    const b = chain('b', 15, 'analysis');
    const bridge: LayoutEdge = edge('a0', 'b0');
    const filler = scattered('f', 30); // 15 + 15 + 30 = 60 > 55
    const nodes = [...a.nodes, ...b.nodes, ...filler];
    const clusters = buildDensityClusters(nodes, [...a.edges, ...b.edges, bridge]);

    expect(clusters).toHaveLength(2);
    const cats = clusters.map((c) => c.category).sort();
    expect(cats).toEqual(['analysis', 'strategy']);
    for (const c of clusters) expect(c.memberIds).toHaveLength(15);
  });

  it('is deterministic across repeat calls', () => {
    const blob = chain('blob', 20, 'strategy');
    const singles = scattered('single', 40);
    const nodes = [...blob.nodes, ...singles];
    const first = buildDensityClusters(nodes, blob.edges);
    const second = buildDensityClusters(nodes, blob.edges);
    expect(second).toEqual(first);
  });

  it('respects a custom threshold', () => {
    const blob = chain('blob', 5, 'strategy');
    const nodes = blob.nodes; // only 5 nodes total — inert at the default threshold of 55
    expect(buildDensityClusters(nodes, blob.edges)).toEqual([]);
    const clusters = buildDensityClusters(nodes, blob.edges, { threshold: 4 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toHaveLength(5);
  });

  it('respects a custom minClusterSize', () => {
    const blob = chain('blob', 3, 'strategy');
    const singles = scattered('single', 53); // 3 + 53 = 56 > 55
    const nodes = [...blob.nodes, ...singles];
    expect(buildDensityClusters(nodes, blob.edges)).toEqual([]); // below default minClusterSize of 4
    const clusters = buildDensityClusters(nodes, blob.edges, { minClusterSize: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toHaveLength(3);
  });
});
