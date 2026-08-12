import { describe, expect, it } from 'vitest';
import { connectedComponents, type LayoutEdge } from '../src/layout.js';
import { DEFAULT_CAP, DEFAULT_FLOOR, planRestructure, type RestructureNode } from '../src/restructure.js';

function node(id: string, title: string, content = ''): RestructureNode {
  return { id, title, content };
}

function edge(from: string, to: string, strength = 0.6): LayoutEdge {
  return { from, to, strength };
}

const applied = (nodes: RestructureNode[], edges: LayoutEdge[], plan: { candidates: Array<{ from: string; to: string }> }) =>
  connectedComponents(nodes, [...edges, ...plan.candidates.map((c) => edge(c.from, c.to))]);

describe('planRestructure', () => {
  it('links two islands whose text is near-identical', () => {
    const nodes = [
      node('a', 'permissions / settings.json', 'allow list of permitted commands'),
      node('b', 'permissions / settings.local.json', 'allow list of permitted commands'),
      node('far', 'wokwi simulation harness', 'runs the esp32 emulator'),
    ];
    const plan = planRestructure(nodes, []);
    expect(plan.candidates).toHaveLength(1);
    expect([plan.candidates[0].from, plan.candidates[0].to].sort()).toEqual(['a', 'b']);
    expect(plan.islandsBefore).toBe(3);
    expect(plan.islandsAfter).toBe(2);
  });

  it('never proposes an edge inside an island — that changes no structure', () => {
    const nodes = [
      node('a', 'oauth token refresh', 'oauth token refresh'),
      node('b', 'oauth token refresh', 'oauth token refresh'),
    ];
    // Already connected, so there is nothing structural to gain.
    const plan = planRestructure(nodes, [edge('a', 'b')]);
    expect(plan.candidates).toEqual([]);
    expect(plan.islandsAfter).toBe(plan.islandsBefore);
  });

  it('never duplicates an existing edge', () => {
    const nodes = [
      node('a', 'oauth token refresh', 'oauth token refresh'),
      node('b', 'oauth token refresh', 'oauth token refresh'),
      node('c', 'unrelated saxophone', 'unrelated saxophone'),
    ];
    const plan = planRestructure(nodes, [edge('a', 'b')]);
    for (const c of plan.candidates) {
      expect([c.from, c.to].sort()).not.toEqual(['a', 'b']);
    }
  });

  it('respects the per-node cap so no node becomes an accidental hub', () => {
    // Five identical-looking nodes, all mutually similar and all separate.
    const nodes = Array.from({ length: 5 }, (_, i) =>
      node(`n${i}`, 'supabase redirect url allowlist', 'supabase redirect url allowlist auth domain'),
    );
    const plan = planRestructure(nodes, [], { cap: 2 });
    const deg = new Map<string, number>();
    for (const c of plan.candidates) {
      deg.set(c.from, (deg.get(c.from) ?? 0) + 1);
      deg.set(c.to, (deg.get(c.to) ?? 0) + 1);
    }
    for (const [id, d] of deg) expect(d, `${id} exceeded the cap`).toBeLessThanOrEqual(2);
  });

  it('actually reduces the island count it claims to', () => {
    const nodes = [
      node('a1', 'docker compose restart', 'docker compose restart container'),
      node('a2', 'docker compose recreate', 'docker compose restart container'),
      node('b1', 'oauth pkce verifier', 'oauth pkce code verifier'),
      node('b2', 'oauth pkce challenge', 'oauth pkce code verifier'),
    ];
    const plan = planRestructure(nodes, []);
    // The reported number must match what the edges really do.
    expect(applied(nodes, [], plan)).toHaveLength(plan.islandsAfter);
  });

  it('leaves genuinely unrelated islands alone', () => {
    const nodes = [
      node('a', 'zebra migration patterns', 'zebra migration patterns'),
      node('b', 'saxophone reed maintenance', 'saxophone reed maintenance'),
    ];
    const plan = planRestructure(nodes, []);
    expect(plan.candidates).toEqual([]);
    expect(plan.islandsAfter).toBe(2);
  });

  it('reports a curve that gets more aggressive as the floor drops', () => {
    const nodes = Array.from({ length: 8 }, (_, i) =>
      node(`n${i}`, `deploy topic ${i}`, `deployment container topic ${i}`),
    );
    const plan = planRestructure(nodes, []);
    const floors = plan.curve.map((p) => p.floor);
    expect(floors).toEqual([...floors].sort((a, b) => b - a));
    for (let i = 1; i < plan.curve.length; i++) {
      expect(plan.curve[i].edges).toBeGreaterThanOrEqual(plan.curve[i - 1].edges);
      expect(plan.curve[i].islands).toBeLessThanOrEqual(plan.curve[i - 1].islands);
    }
  });

  it('is pure — inputs are untouched and nothing is written', () => {
    const nodes = [
      node('a', 'oauth token refresh', 'oauth token refresh'),
      node('b', 'oauth token refreshing', 'oauth token refresh'),
    ];
    const edges: LayoutEdge[] = [];
    const before = JSON.stringify({ nodes, edges });
    planRestructure(nodes, edges);
    expect(JSON.stringify({ nodes, edges })).toBe(before);
  });

  it('is deterministic', () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      node(`n${i}`, `supabase auth redirect ${i}`, 'supabase auth redirect allowlist'),
    );
    expect(planRestructure(nodes, [])).toEqual(planRestructure(nodes, []));
  });

  it('keeps the defaults aligned with importApply, so this stays a backfill', () => {
    // If importApply's SIMILARITY_MIN / MAX_SIMILARITY_EDGES ever change, these
    // should change with them — otherwise `restructure` starts asserting links
    // the importer itself would refuse to make.
    expect(DEFAULT_FLOOR).toBe(0.4);
    expect(DEFAULT_CAP).toBe(2);
  });

  it('uses embeddings as a SEPARATE signal, never blended into the trigram score', () => {
    // Two nodes that mean the same thing but share almost no spelling.
    const nodes = [
      node('x', 'OAuth callback handshake', 'the browser returns a code to the local server'),
      node('y', 'login redirect completion', 'user comes back and we exchange the grant'),
    ];
    const vectors = new Map([
      ['x', Float32Array.from([1, 0, 0])],
      ['y', Float32Array.from([0.95, 0.31, 0])], // cosine ≈ 0.95
    ]);
    const without = planRestructure(nodes, []);
    expect(without.candidates).toEqual([]);
    expect(without.semanticUsed).toBe(false);

    const withVecs = planRestructure(nodes, [], { vectors });
    expect(withVecs.semanticUsed).toBe(true);
    expect(withVecs.candidates).toHaveLength(1);
    expect(withVecs.candidates[0].via).toBe('semantic');
    // The recorded similarity is the cosine, not some blended number.
    expect(withVecs.candidates[0].sim).toBeGreaterThan(0.9);
  });

  it('ignores embeddings below the semantic floor', () => {
    const nodes = [node('x', 'alpha', 'alpha'), node('y', 'beta', 'beta')];
    const vectors = new Map([
      ['x', Float32Array.from([1, 0, 0])],
      ['y', Float32Array.from([0, 1, 0])], // cosine 0
    ]);
    expect(planRestructure(nodes, [], { vectors }).candidates).toEqual([]);
  });

  it('handles an empty graph', () => {
    const plan = planRestructure([], []);
    expect(plan.candidates).toEqual([]);
    expect(plan.islandsBefore).toBe(0);
  });
});
