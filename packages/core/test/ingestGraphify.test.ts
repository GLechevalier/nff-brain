import { describe, expect, it } from 'vitest';
import {
  applyExplanations,
  applyGraphifyImport,
  buildExplainPrompt,
  buildGraphifyImport,
  emptyBrain,
  expandGraphifyRef,
  parseCommunityLabels,
  parseGraphifyGraph,
  recallBrain,
  repoOfFile,
  upsertEdge,
  upsertNode,
} from '../src/index.js';
import type { BrainNode, CommunityLabel, GraphifyGraph } from '../src/index.js';

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: `content ${id}`,
    color: '#a78bfa',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    recallCount: 0,
    ...extra,
  };
}

// Two fake repos: repo-a (auth community 0 + hyperedge) and repo-b (data community 1),
// with one cross-community link (a3 -> b1).
function fixtureGraph(): GraphifyGraph {
  return {
    nodes: [
      { id: 'a1', label: 'auth_login', fileType: 'code', sourceFile: 'repo-a/auth/login.py', community: 0 },
      { id: 'a2', label: 'auth_logout', fileType: 'code', sourceFile: 'repo-a/auth/logout.py', community: 0 },
      { id: 'a3', label: 'session_store', fileType: 'code', sourceFile: 'repo-a/auth/session.py', community: 0 },
      { id: 'b1', label: 'db_conn', fileType: 'code', sourceFile: 'repo-b/db/conn.py', community: 1 },
      { id: 'b2', label: 'db_query', fileType: 'code', sourceFile: 'repo-b/db/query.py', community: 1 },
    ],
    links: [
      { source: 'a1', target: 'a3', relation: 'calls', confidenceScore: 1.0 },
      { source: 'a2', target: 'a3', relation: 'calls', confidenceScore: 1.0 },
      { source: 'a3', target: 'b1', relation: 'shares_data_with', confidenceScore: 0.85 },
      { source: 'b1', target: 'b2', relation: 'calls', confidenceScore: 1.0 },
    ],
    hyperedges: [
      {
        id: 'h1',
        label: 'Login Flow',
        nodes: ['a1', 'a3'],
        relation: 'form',
        confidenceScore: 1.0,
        sourceFile: 'repo-a/auth/login.py',
      },
    ],
  };
}

function fixtureLabels(): Map<number, CommunityLabel> {
  return new Map([
    [0, { label: 'Auth Layer', cohesion: 0.42 }],
    [1, { label: 'Data Layer', cohesion: 0.31 }],
  ]);
}

describe('parseGraphifyGraph', () => {
  it('parses node-link JSON with top-level hyperedges', () => {
    const g = parseGraphifyGraph(
      JSON.stringify({
        directed: false,
        graph: {},
        nodes: [
          { id: 'x', label: 'X', file_type: 'code', source_file: 'r/x.py', community: 0 },
          { id: 'y', label: 'Y', file_type: 'code', source_file: 'r/y.py', community: 0 },
        ],
        links: [{ source: 'x', target: 'y', relation: 'calls', confidence_score: 0.9 }],
        hyperedges: [{ id: 'h', label: 'H', nodes: ['x', 'y'], relation: 'form', confidence_score: 1.0 }],
      }),
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.links[0].confidenceScore).toBe(0.9);
    expect(g.hyperedges).toHaveLength(1);
  });

  it('falls back to graph.hyperedges and drops links/members pointing at unknown nodes', () => {
    const g = parseGraphifyGraph(
      JSON.stringify({
        graph: { hyperedges: [{ id: 'h', label: 'H', nodes: ['x', 'ghost', 'y'], relation: 'form' }] },
        nodes: [{ id: 'x' }, { id: 'y' }],
        links: [
          { source: 'x', target: 'y' },
          { source: 'x', target: 'ghost' },
        ],
      }),
    );
    expect(g.links).toHaveLength(1);
    expect(g.hyperedges[0].nodes).toEqual(['x', 'y']);
  });

  it('throws descriptive errors on bad input', () => {
    expect(() => parseGraphifyGraph('not json')).toThrow('not valid JSON');
    expect(() => parseGraphifyGraph('{"foo": 1}')).toThrow('unrecognized graph.json');
  });
});

describe('parseCommunityLabels', () => {
  it('extracts labels and cohesion, keeping placeholders as-is', () => {
    const report = [
      '### Community 0 - "Auth Layer"',
      'Cohesion: 0.42',
      'Nodes (3): a, b, c',
      '',
      '### Community 20 - "Module Group 20"',
      'Cohesion: 0.05',
    ].join('\n');
    const labels = parseCommunityLabels(report);
    expect(labels.get(0)).toEqual({ label: 'Auth Layer', cohesion: 0.42 });
    expect(labels.get(20)?.label).toBe('Module Group 20');
  });
});

describe('repoOfFile', () => {
  it('takes the top-level segment, tolerating backslashes and bare files', () => {
    expect(repoOfFile('repo-a/auth/login.py')).toBe('repo-a');
    expect(repoOfFile('repo-a\\auth\\login.py')).toBe('repo-a');
    expect(repoOfFile('README.md')).toBe('(root)');
  });
});

describe('buildGraphifyImport', () => {
  it('creates area/god/flow nodes with the right shape and graphifyRef', () => {
    const imp = buildGraphifyImport(fixtureGraph(), fixtureLabels(), { graphPath: 'graphify-out/graph.json' });
    const ids = imp.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['gf-area-auth-layer', 'gf-area-data-layer', 'gf-flow-login-flow', 'gf-god-session-store']);

    const area = imp.nodes.find((n) => n.id === 'gf-area-auth-layer')!;
    expect(area.category).toBe('analysis');
    expect(area.origin).toBe('graphify');
    expect(area.title).toBe('Auth Layer');
    expect(area.graphifyRef).toMatchObject({ kind: 'community', key: 0, graph: 'graphify-out/graph.json' });
    expect(area.graphifyRef!.children).toContain('a1');
    expect(area.content).toContain('↳ graphify community 0');
    expect(area.content).toContain('auth_login (repo-a/auth/login.py)');
    expect(area.content.length).toBeLessThanOrEqual(1200);

    const god = imp.nodes.find((n) => n.id === 'gf-god-session-store')!;
    expect(god.category).toBe('core');
    expect(god.graphifyRef).toMatchObject({ kind: 'node', key: 'a3' });

    const flow = imp.nodes.find((n) => n.id === 'gf-flow-login-flow')!;
    expect(flow.category).toBe('strategy');
    expect(flow.graphifyRef).toMatchObject({ kind: 'hyperedge', key: 'h1' });
    expect(flow.graphifyRef!.children).toEqual(['a1', 'a3']);
  });

  it('links god→area, flow→area and cross-community area→area', () => {
    const imp = buildGraphifyImport(fixtureGraph(), fixtureLabels(), {});
    const has = (a: string, b: string) =>
      imp.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    expect(has('gf-god-session-store', 'gf-area-auth-layer')).toBe(true);
    expect(has('gf-flow-login-flow', 'gf-area-auth-layer')).toBe(true);
    expect(has('gf-area-auth-layer', 'gf-area-data-layer')).toBe(true);
    const cross = imp.edges.find(
      (e) => [e.from, e.to].sort().join() === 'gf-area-auth-layer,gf-area-data-layer',
    )!;
    expect(cross.strength).toBe(0.85);
  });

  it('derives titles from top hubs when the label is missing or a placeholder', () => {
    const labels = new Map<number, CommunityLabel>([[0, { label: 'Module Group 0' }]]);
    const imp = buildGraphifyImport(fixtureGraph(), labels, {});
    const areas = imp.nodes.filter((n) => n.graphifyRef?.kind === 'community');
    // community 0: top hub is session_store (deg 3), then auth_login.
    expect(areas.some((a) => a.title === 'session_store / auth_login')).toBe(true);
    // community 1 has no label at all → derived too.
    expect(areas.some((a) => a.title === 'db_conn / db_query')).toBe(true);
  });

  it('enforces the per-repo cap and reports drops', () => {
    const g = fixtureGraph();
    // Pile 4 more communities into repo-a so it has 5 areas + 1 flow + 1 god candidates.
    let id = 0;
    for (let c = 2; c <= 5; c++) {
      const n1 = `x${id++}`;
      const n2 = `x${id++}`;
      g.nodes.push(
        { id: n1, label: n1, fileType: 'code', sourceFile: `repo-a/mod${c}/a.py`, community: c },
        { id: n2, label: n2, fileType: 'code', sourceFile: `repo-a/mod${c}/b.py`, community: c },
      );
      g.links.push({ source: n1, target: n2, relation: 'calls', confidenceScore: 1.0 });
    }
    const imp = buildGraphifyImport(g, fixtureLabels(), { maxPerRepo: 3 });
    expect(imp.perRepo['repo-a'].kept).toBe(3);
    expect(imp.perRepo['repo-a'].total).toBeGreaterThan(3);
    expect(imp.perRepo['repo-b'].kept).toBe(1);
    // Ranking: the real-labeled community, the flow and the god beat unnamed communities.
    const ids = imp.nodes.map((n) => n.id);
    expect(ids).toContain('gf-area-auth-layer');
    expect(ids).toContain('gf-flow-login-flow');
    expect(ids).toContain('gf-god-session-store');
  });
});

describe('explanations', () => {
  it('prompt lists every subject id and asks for strict JSON', () => {
    const imp = buildGraphifyImport(fixtureGraph(), fixtureLabels(), {});
    const prompt = buildExplainPrompt(imp.subjects);
    expect(prompt).toContain('graph explainer');
    for (const s of imp.subjects) expect(prompt).toContain(`id="${s.id}"`);
    expect(prompt).toContain('"explanations"');
  });

  it('applyExplanations prepends intent text, tolerating junk', () => {
    const imp = buildGraphifyImport(fixtureGraph(), fixtureLabels(), {});
    const applied = applyExplanations(
      imp.nodes,
      'Sure! Here you go:\n{"explanations": {"gf-area-auth-layer": "Owns authentication.", "unknown-id": "x", "gf-god-session-store": 42}}',
    );
    expect(applied).toBe(1);
    const area = imp.nodes.find((n) => n.id === 'gf-area-auth-layer')!;
    expect(area.content.startsWith('Owns authentication.')).toBe(true);
    expect(area.content).toContain('↳ graphify community 0'); // mechanical part kept
    expect(applyExplanations(imp.nodes, 'no json at all')).toBe(0);
  });
});

describe('applyGraphifyImport', () => {
  it('replaces old graphify nodes wholesale, leaving seed/agent untouched', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('lesson', { origin: 'agent' }));
    upsertNode(brain, node('curated', { origin: 'seed' }));
    upsertEdge(brain, { from: 'lesson', to: 'curated', strength: 0.5 });

    const imp1 = buildGraphifyImport(fixtureGraph(), fixtureLabels(), {});
    const r1 = applyGraphifyImport(brain, imp1);
    expect(r1.removed).toBe(0);
    expect(r1.added).toBe(4);

    // Re-import is idempotent: same ids, old graphify set fully replaced.
    const imp2 = buildGraphifyImport(fixtureGraph(), fixtureLabels(), {});
    const r2 = applyGraphifyImport(brain, imp2);
    expect(r2.removed).toBe(4);
    expect(brain.nodes.filter((n) => n.origin === 'graphify')).toHaveLength(4);
    expect(brain.nodes.some((n) => n.id === 'lesson')).toBe(true);
    expect(brain.nodes.some((n) => n.id === 'curated')).toBe(true);
    expect(brain.edges.some((e) => e.from === 'lesson' && e.to === 'curated')).toBe(true);
  });
});

describe('expandGraphifyRef', () => {
  it('resolves children and their internal links, counting stale ids', () => {
    const g = fixtureGraph();
    const ref = { graph: 'graphify-out/graph.json', kind: 'community' as const, key: 0, children: ['a1', 'a3', 'gone'] };
    const { children, internalLinks, missing } = expandGraphifyRef(ref, g);
    expect(children.map((c) => c.id)).toEqual(['a1', 'a3']);
    expect(internalLinks).toHaveLength(1);
    expect(internalLinks[0].relation).toBe('calls');
    expect(missing).toBe(1);
  });
});

describe('recall preamble bridge', () => {
  it('marks graphify nodes with the expand hint and adds the footer', () => {
    const graph = {
      nodes: [
        node('gf-area-auth-layer', { origin: 'graphify', title: 'Auth Layer', content: 'Owns auth.' }),
        node('lesson', { title: 'A lesson', content: 'Do X.' }),
      ],
      edges: [],
    };
    const { preamble } = recallBrain(graph, 'anything');
    expect(preamble).toContain('(expand: nff-brain expand gf-area-auth-layer)');
    expect(preamble).toContain('codebase-map nodes imported from graphify');
    expect(preamble).not.toContain('(expand: nff-brain expand lesson)');
  });

  it('renders exactly as before when no graphify nodes are present', () => {
    const { preamble } = recallBrain({ nodes: [node('lesson')], edges: [] }, 'anything');
    expect(preamble).not.toContain('expand');
    expect(preamble).not.toContain('graphify');
    expect(preamble.endsWith('\n\n---\n')).toBe(true);
  });
});
