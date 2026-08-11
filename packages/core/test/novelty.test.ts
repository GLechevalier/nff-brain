import { describe, expect, it } from 'vitest';
import { DEFAULT_LADDER, DEFAULT_THRESHOLDS, modelLadder, pickModel, scoreNovelty } from '../src/index.js';
import type { BrainEdge, BrainNode } from '../src/index.js';

function node(id: string, title: string, content: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title,
    category: 'strategy',
    content,
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

describe('modelLadder', () => {
  it('defaults without env', () => {
    const { ladder, thresholds } = modelLadder({});
    expect(ladder).toEqual([...DEFAULT_LADDER]);
    expect(thresholds).toEqual([...DEFAULT_THRESHOLDS]);
  });

  it('reads a custom ladder and thresholds', () => {
    const { ladder, thresholds } = modelLadder({
      NFF_BRAIN_MODEL_LADDER: 'sonnet, opus',
      NFF_BRAIN_NOVELTY_THRESHOLDS: '0.5',
    });
    expect(ladder).toEqual(['sonnet', 'opus']);
    expect(thresholds).toEqual([0.5]);
  });

  it('falls back to even spacing when thresholds are malformed for the ladder', () => {
    // Wrong length for a 2-tier ladder.
    const a = modelLadder({ NFF_BRAIN_MODEL_LADDER: 'sonnet,opus', NFF_BRAIN_NOVELTY_THRESHOLDS: '0.3,0.6' });
    expect(a.thresholds).toEqual([0.5]);
    // Non-ascending.
    const b = modelLadder({ NFF_BRAIN_NOVELTY_THRESHOLDS: '0.7,0.3' });
    expect(b.thresholds).toEqual([...DEFAULT_THRESHOLDS]);
    // Non-numeric.
    const c = modelLadder({ NFF_BRAIN_NOVELTY_THRESHOLDS: 'low,high' });
    expect(c.thresholds).toEqual([...DEFAULT_THRESHOLDS]);
    // 4-tier ladder without thresholds → even spacing.
    const d = modelLadder({ NFF_BRAIN_MODEL_LADDER: 'haiku,sonnet,opus,fable' });
    expect(d.thresholds).toEqual([0.25, 0.5, 0.75]);
  });

  it('ignores an empty ladder value', () => {
    const { ladder } = modelLadder({ NFF_BRAIN_MODEL_LADDER: ' , ,' });
    expect(ladder).toEqual([...DEFAULT_LADDER]);
  });
});

describe('pickModel', () => {
  it('maps novelty to tiers with exclusive upper cuts', () => {
    const ladder = ['haiku', 'sonnet', 'opus'];
    const thresholds = [0.35, 0.7];
    expect(pickModel(0, ladder, thresholds)).toBe('haiku');
    expect(pickModel(0.34, ladder, thresholds)).toBe('haiku');
    expect(pickModel(0.35, ladder, thresholds)).toBe('sonnet');
    expect(pickModel(0.69, ladder, thresholds)).toBe('sonnet');
    expect(pickModel(0.7, ladder, thresholds)).toBe('opus');
    expect(pickModel(1, ladder, thresholds)).toBe('opus');
  });
});

describe('scoreNovelty', () => {
  const edgesFor = (hub: string, n: number, strength: number): BrainEdge[] =>
    Array.from({ length: n }, (_, i) => ({ from: hub, to: `nb-${i}`, strength }));

  it('empty graph is maximally novel → frontier model', () => {
    const r = scoreNovelty({ nodes: [], edges: [] }, 'anything at all');
    expect(r.novelty).toBe(1);
    expect(r.model).toBe(r.ladder[r.ladder.length - 1]);
    expect(r.top).toHaveLength(0);
  });

  it('empty/stopword-only query is maximally novel', () => {
    const nodes = [node('a', 'Alpha', 'aaa')];
    expect(scoreNovelty({ nodes, edges: [] }, '').novelty).toBe(1);
    expect(scoreNovelty({ nodes, edges: [] }, 'the and for').novelty).toBe(1);
  });

  it('no lexical match is maximally novel even on a tiny graph (no whole-graph bypass)', () => {
    const nodes = [node('a', 'Docker restart', 'force-recreate wedged containers')];
    const r = scoreNovelty({ nodes, edges: [] }, 'zzzzqqqq quantum entanglement telescope');
    expect(r.novelty).toBe(1);
    expect(r.top).toHaveLength(0);
  });

  it('a strong, well-connected, often-recalled anchor makes the task familiar → cheap model', () => {
    const strong = node('docker-restart', 'Docker restart procedure', 'force-recreate wedged containers with compose', {
      recallCount: 40,
    });
    const neighbors = Array.from({ length: 7 }, (_, i) => node(`nb-${i}`, `Neighbor ${i}`, `filler ${i}`));
    const r = scoreNovelty(
      { nodes: [strong, ...neighbors], edges: edgesFor('docker-restart', 7, 0.9) },
      'docker restart procedure for wedged containers',
    );
    expect(r.top[0].id).toBe('docker-restart');
    expect(r.novelty).toBeLessThan(0.35);
    expect(r.model).toBe('haiku');
  });

  it('a matching but weak periphery node stays novel → frontier model', () => {
    const weak = node('weak', 'Quantum telemetry probe', 'experimental quantum telemetry probe notes', {
      recallCount: 0,
    });
    const other = node('other', 'Other', 'unrelated filler');
    const edges: BrainEdge[] = [{ from: 'weak', to: 'other', strength: 0.3 }];
    const r = scoreNovelty({ nodes: [weak, other], edges }, 'quantum telemetry probe experiments');
    expect(r.top[0].id).toBe('weak');
    expect(r.novelty).toBeGreaterThanOrEqual(0.7);
    expect(r.model).toBe('opus');
  });

  it('a middling anchor lands on the middle tier', () => {
    const mid = node('mid', 'Fleet enrollment flow', 'devices announce then get claimed and enrolled', {
      recallCount: 2,
    });
    const nbs = [node('nb-0', 'NB0', 'x'), node('nb-1', 'NB1', 'y')];
    const edges: BrainEdge[] = [
      { from: 'mid', to: 'nb-0', strength: 0.5 },
      { from: 'mid', to: 'nb-1', strength: 0.5 },
    ];
    const r = scoreNovelty({ nodes: [mid, ...nbs], edges }, 'fleet enrollment flow for devices');
    expect(r.top[0].id).toBe('mid');
    expect(r.novelty).toBeGreaterThanOrEqual(0.35);
    expect(r.novelty).toBeLessThan(0.7);
    expect(r.model).toBe('sonnet');
  });

  it('weak lexical coverage keeps novelty high even when the matched node is strong', () => {
    const strong = node('strong', 'Docker restart procedure', 'force-recreate wedged containers', {
      recallCount: 40,
    });
    const neighbors = Array.from({ length: 7 }, (_, i) => node(`nb-${i}`, `Neighbor ${i}`, `filler ${i}`));
    const graph = { nodes: [strong, ...neighbors], edges: edgesFor('strong', 7, 0.9) };
    // Only one of many query tokens grazes the node — coverage should damp familiarity.
    const grazing = scoreNovelty(graph, 'kubernetes ingress certificate rotation on the docker host maybe');
    const direct = scoreNovelty(graph, 'docker restart procedure for wedged containers');
    expect(grazing.novelty).toBeGreaterThan(direct.novelty);
  });

  it('respects an explicit ladder/thresholds override', () => {
    const r = scoreNovelty({ nodes: [], edges: [] }, 'anything', {
      ladder: ['a', 'b'],
      thresholds: [0.5],
    });
    expect(r.model).toBe('b');
    expect(r.ladder).toEqual(['a', 'b']);
  });
});
