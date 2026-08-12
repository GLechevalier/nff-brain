import { describe, expect, it } from 'vitest';
import { buildAdjacency, type LayoutEdge } from '../src/layout.js';
import { buildSpine, isSpineId, resolveRoot, type SpineInputNode } from '../src/spine.js';

function node(id: string, extra: Partial<SpineInputNode> = {}): SpineInputNode {
  return { id, title: id, content: `content of ${id}`, category: 'strategy', ...extra };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

/**
 * A connected island of `n` nodes whose text is all about `topic`.
 *
 * Carries NO filler words: boilerplate like "node"/"details" in every fixture
 * island would be a shared token in every term vector and quietly inflate every
 * similarity. The index is a single digit, which `tokenize` drops (min 3 chars).
 */
function island(prefix: string, n: number, topic: string) {
  const nodes: SpineInputNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(node(`${prefix}${i}`, { title: `${topic} ${i}`, content: `${topic} ${topic} ${i}` }));
    if (i > 0) edges.push(edge(`${prefix}${i - 1}`, `${prefix}${i}`));
  }
  return { nodes, edges };
}

/** Every id reachable from `rootId` over the combined real + virtual edges. */
function reachable(
  rootId: string,
  nodes: readonly { id: string }[],
  edges: readonly LayoutEdge[],
): Set<string> {
  const adj = buildAdjacency(nodes, edges);
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!) ?? []) {
      if (seen.has(nb.id)) continue;
      seen.add(nb.id);
      stack.push(nb.id);
    }
  }
  return seen;
}

describe('resolveRoot', () => {
  it('prefers the seed hub over a graphify god node with the same category', () => {
    // THE BUG: graphify imports its "god" nodes as category 'core' too, so a
    // real brain holds several. The old `find(c === 'core')` returned whichever
    // sat first in the array — here, the god node.
    const nodes = [
      node('gf-god-test-wokwi-py', { category: 'core', origin: 'graphify' }),
      node('nff-cli-mcp', { category: 'core', origin: 'seed' }),
    ];
    expect(resolveRoot(nodes, [])).toBe('nff-cli-mcp');
  });

  it('is invariant to node array order', () => {
    const nodes = [
      node('gf-god-a', { category: 'core', origin: 'graphify' }),
      node('hub', { category: 'core', origin: 'seed' }),
      node('gf-god-b', { category: 'core', origin: 'graphify' }),
    ];
    const forward = resolveRoot(nodes, []);
    const backward = resolveRoot([...nodes].reverse(), []);
    expect(forward).toBe('hub');
    expect(backward).toBe('hub');
  });

  it('falls back to the highest-degree core node when no seed hub exists', () => {
    const nodes = [
      node('lonely', { category: 'core', origin: 'graphify' }),
      node('busy', { category: 'core', origin: 'graphify' }),
      node('x'),
      node('y'),
    ];
    const edges = [edge('busy', 'x'), edge('busy', 'y')];
    expect(resolveRoot(nodes, edges)).toBe('busy');
  });

  it('falls back to the highest-degree node when nothing is core', () => {
    const nodes = [node('a'), node('b'), node('c')];
    expect(resolveRoot(nodes, [edge('b', 'a'), edge('b', 'c')])).toBe('b');
  });

  it('breaks ties lexicographically, not by position', () => {
    const nodes = [node('zebra'), node('alpha')];
    expect(resolveRoot(nodes, [])).toBe('alpha');
    expect(resolveRoot([...nodes].reverse(), [])).toBe('alpha');
  });

  it('honours an explicit rootId, and ignores one that does not exist', () => {
    const nodes = [node('hub', { category: 'core', origin: 'seed' }), node('other')];
    expect(resolveRoot(nodes, [], 'other')).toBe('other');
    expect(resolveRoot(nodes, [], 'ghost')).toBe('hub');
  });

  it('returns null for an empty graph', () => {
    expect(resolveRoot([], [])).toBeNull();
  });
});

describe('buildSpine', () => {
  const root = node('hub', { category: 'core', origin: 'seed' });

  it('connects every island to the root', () => {
    const a = island('a', 3, 'auth oauth token');
    const b = island('b', 3, 'deploy docker compose');
    const c = island('c', 1, 'wokwi simulation');
    const nodes = [root, ...a.nodes, ...b.nodes, ...c.nodes];
    const edges = [...a.edges, ...b.edges, ...c.edges];

    // Before: four separate components.
    expect(reachable('hub', nodes, edges).size).toBe(1);

    const spine = buildSpine(nodes, edges);
    const all = [...nodes, ...spine.nodes];
    const combined = [...edges, ...spine.edges];
    expect(reachable('hub', all, combined).size).toBe(all.length);
    expect(spine.islandCount).toBe(3);
  });

  it('adds no grouping nodes when the islands already fit the fan-out', () => {
    const a = island('a', 2, 'auth');
    const b = island('b', 2, 'deploy');
    const spine = buildSpine([root, ...a.nodes, ...b.nodes], [...a.edges, ...b.edges], { fanout: 7 });
    expect(spine.nodes).toEqual([]);
    // Each island is linked by its anchor alone, not by every member.
    expect(spine.edges).toHaveLength(2);
    expect(spine.edges.every((e) => e.from === 'hub')).toBe(true);
  });

  it('inserts grouping nodes and keeps every fan-out within the limit', () => {
    const fanout = 3;
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    const topics = ['auth', 'deploy', 'serial', 'wokwi', 'billing', 'render', 'cache', 'queue'];
    topics.forEach((t, i) => {
      const isl = island(`i${i}_`, 2, t);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    });

    const spine = buildSpine(nodes, edges, { fanout });
    expect(spine.nodes.length).toBeGreaterThan(0);

    const children = new Map<string, number>();
    for (const e of spine.edges) children.set(e.from, (children.get(e.from) ?? 0) + 1);
    for (const [parent, count] of children) {
      expect(count, `${parent} has ${count} children, over the fan-out of ${fanout}`).toBeLessThanOrEqual(fanout);
    }
    const all = [...nodes, ...spine.nodes];
    expect(reachable('hub', all, [...edges, ...spine.edges]).size).toBe(all.length);
  });

  it('spends the whole fan-out budget rather than making the fewest groups', () => {
    // 12 islands with a fan-out of 7 could be held by 2 groups of 6 or by 7
    // groups of ~2. Both are the same depth, so the wider one wins: smaller
    // groups are more coherent. Minimising group count once forced 19 islands
    // into 3 buckets and two came back labelled "misc".
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 12; i++) {
      const isl = island(`n${i}_`, 1, `topic${i}`);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    }
    const spine = buildSpine(nodes, edges, { fanout: 7 });
    const top = spine.edges.filter((e) => e.from === 'hub').length;
    expect(top).toBeGreaterThan(2);
    expect(top).toBeLessThanOrEqual(7);
  });

  it('nests deeper as the island count grows', () => {
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 30; i++) {
      const isl = island(`n${i}_`, 1, `topic${i}`);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    }
    const spine = buildSpine(nodes, edges, { fanout: 3 });
    expect(Math.max(...spine.nodes.map((n) => n.level))).toBeGreaterThanOrEqual(2);
  });

  it('attaches an island at its most connected member', () => {
    // A star: 'centre' has three spokes, so the spine must land on 'centre'.
    const nodes = [root, node('centre'), node('s1'), node('s2'), node('s3')];
    const edges = [edge('centre', 's1'), edge('centre', 's2'), edge('centre', 's3')];
    const spine = buildSpine(nodes, edges);
    expect(spine.edges).toEqual([{ from: 'hub', to: 'centre', strength: 0.3 }]);
  });

  it('leaves the root’s own component alone', () => {
    // Real edges already reach the root — the spine must not duplicate them.
    const nodes = [root, node('a'), node('b')];
    const edges = [edge('hub', 'a'), edge('a', 'b')];
    const spine = buildSpine(nodes, edges);
    expect(spine.islandCount).toBe(0);
    expect(spine.edges).toEqual([]);
    expect(spine.nodes).toEqual([]);
  });

  it('groups by topic, not by arrival order', () => {
    // Two auth islands and two deploy islands, interleaved. With a fan-out of 2
    // they must be paired by subject.
    const a1 = island('a1_', 2, 'oauth token pkce authorize');
    const d1 = island('d1_', 2, 'docker compose deploy container');
    const a2 = island('a2_', 2, 'oauth token refresh authorize');
    const d2 = island('d2_', 2, 'docker compose restart container');
    const nodes = [root, ...a1.nodes, ...d1.nodes, ...a2.nodes, ...d2.nodes];
    const edges = [...a1.edges, ...d1.edges, ...a2.edges, ...d2.edges];

    const spine = buildSpine(nodes, edges, { fanout: 2 });
    const groups = spine.nodes.filter((n) => n.level === 1);
    expect(groups).toHaveLength(2);
    // Each group holds one auth island and… no: both auth islands together.
    for (const g of groups) {
      const prefixes = new Set(g.memberIds.map((id) => id[0]));
      expect(prefixes.size, `group "${g.title}" mixes topics: ${g.memberIds.join(',')}`).toBe(1);
    }
  });

  it('labels groups with terms their members actually share', () => {
    const a1 = island('a1_', 2, 'oauth token pkce');
    const a2 = island('a2_', 2, 'oauth token refresh');
    const d1 = island('d1_', 2, 'docker compose deploy');
    const d2 = island('d2_', 2, 'docker compose restart');
    const nodes = [root, ...a1.nodes, ...a2.nodes, ...d1.nodes, ...d2.nodes];
    const edges = [...a1.edges, ...a2.edges, ...d1.edges, ...d2.edges];
    const spine = buildSpine(nodes, edges, { fanout: 2 });
    const titles = spine.nodes.map((n) => n.title).join(' | ');
    expect(titles).toMatch(/oauth|token|pkce|refresh/);
    expect(titles).toMatch(/docker|compose|deploy|restart/);
  });

  it('calls an incoherent group "misc" rather than inventing a theme for it', () => {
    // Fan-out forces every island into some group, so a group is not
    // necessarily a topic. Four mutually unrelated islands + a tight pair:
    // the leftovers must be labelled honestly.
    const tight1 = island('t1_', 2, 'oauth token pkce authorize refresh');
    const tight2 = island('t2_', 2, 'oauth token pkce authorize verifier');
    const odd = ['zebra', 'concrete', 'saxophone', 'tuesday'].map((w, i) =>
      island(`o${i}_`, 1, w),
    );
    const nodes = [root, ...tight1.nodes, ...tight2.nodes, ...odd.flatMap((o) => o.nodes)];
    const edges = [...tight1.edges, ...tight2.edges, ...odd.flatMap((o) => o.edges)];

    const spine = buildSpine(nodes, edges, { fanout: 2, minSim: 0.13 });
    const titles = spine.nodes.map((n) => n.title);
    expect(titles).toContain('misc');
    for (const n of spine.nodes) {
      expect(n.title === 'misc' || n.cohesion >= 0.13).toBe(true);
    }
  });

  it('summarises what is under each grouping node', () => {
    const a = island('a', 3, 'oauth token');
    const b = island('b', 2, 'oauth pkce');
    const c = island('c', 2, 'docker compose');
    const nodes = [root, ...a.nodes, ...b.nodes, ...c.nodes].map((n) =>
      n.id === 'hub' ? n : { ...n, category: 'analysis' },
    );
    const spine = buildSpine(nodes, [...a.edges, ...b.edges, ...c.edges], { fanout: 2 });
    const g = spine.nodes[0];
    // Counts, kind, and the islands' own titles — all extractive.
    expect(g.summary).toMatch(/\d+ nodes across \d+ islands/);
    expect(g.summary).toContain('mostly analysis');
    // Every id it claims is really under it.
    expect(g.memberIds.length).toBeGreaterThan(0);
    for (const id of g.memberIds) expect(nodes.some((n) => n.id === id)).toBe(true);
  });

  it('summarises a single-island group without pluralising it', () => {
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 6; i++) {
      const isl = island(`n${i}_`, 1, `topic${i}`);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    }
    const spine = buildSpine(nodes, edges, { fanout: 2 });
    for (const s of spine.nodes) {
      expect(s.summary).not.toContain('1 islands');
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });

  it('reports cohesion on every grouping node', () => {
    const a = island('a', 2, 'oauth token');
    const b = island('b', 2, 'oauth token');
    const c = island('c', 2, 'docker compose');
    const nodes = [root, ...a.nodes, ...b.nodes, ...c.nodes];
    const spine = buildSpine(nodes, [...a.edges, ...b.edges, ...c.edges], { fanout: 2 });
    for (const n of spine.nodes) {
      expect(n.cohesion).toBeGreaterThanOrEqual(0);
      expect(n.cohesion).toBeLessThanOrEqual(1);
    }
  });

  it('gives spine nodes ids that cannot collide with real ones', () => {
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 10; i++) {
      const isl = island(`n${i}_`, 1, `topic${i}`);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    }
    const spine = buildSpine(nodes, edges, { fanout: 3 });
    // slug() strips everything outside [a-z0-9-], so a colon is unreachable.
    for (const n of spine.nodes) expect(isSpineId(n.id)).toBe(true);
    expect(new Set(spine.nodes.map((n) => n.id)).size).toBe(spine.nodes.length);
    expect(spine.nodes.some((n) => nodes.some((r) => r.id === n.id))).toBe(false);
  });

  it('is deterministic', () => {
    const nodes: SpineInputNode[] = [root];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 12; i++) {
      const isl = island(`n${i}_`, 2, `topic${i % 4}`);
      nodes.push(...isl.nodes);
      edges.push(...isl.edges);
    }
    expect(buildSpine(nodes, edges, { fanout: 3 })).toEqual(buildSpine(nodes, edges, { fanout: 3 }));
  });

  it('never mutates its inputs', () => {
    const a = island('a', 3, 'auth');
    const nodes = [root, ...a.nodes];
    const edges = [...a.edges];
    const nodesBefore = JSON.stringify(nodes);
    const edgesBefore = JSON.stringify(edges);
    buildSpine(nodes, edges);
    expect(JSON.stringify(nodes)).toBe(nodesBefore);
    expect(JSON.stringify(edges)).toBe(edgesBefore);
  });

  it('returns an empty spine for an empty graph', () => {
    expect(buildSpine([], [])).toEqual({ rootId: null, nodes: [], edges: [], islandCount: 0 });
  });
});
