import { describe, expect, it } from 'vitest';
import {
  chooseSurvivor,
  emptyBrain,
  foldLeastUsed,
  mergeNodes,
  runMergePass,
  upsertEdge,
  upsertNode,
} from '../src/index.js';
import type { BrainNode } from '../src/index.js';

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

describe('chooseSurvivor', () => {
  const degree = new Map<string, number>();
  it('never merges two seeds', () => {
    expect(chooseSurvivor(node('a', { origin: 'seed' }), node('b', { origin: 'seed' }), degree)).toBeNull();
  });
  it('seed beats agent', () => {
    const [s, l] = chooseSurvivor(node('a'), node('b', { origin: 'seed' }), degree)!;
    expect(s.id).toBe('b');
    expect(l.id).toBe('a');
  });
  it('higher degree wins between agents, id tiebreak', () => {
    const deg = new Map([
      ['a', 1],
      ['b', 3],
    ]);
    expect(chooseSurvivor(node('a'), node('b'), deg)![0].id).toBe('b');
    expect(chooseSurvivor(node('x'), node('y'), new Map())![0].id).toBe('x');
  });
});

describe('mergeNodes', () => {
  it('repoints edges with max strength and deletes the loser', () => {
    const brain = emptyBrain();
    for (const id of ['s', 'l', 'other']) upsertNode(brain, node(id));
    upsertEdge(brain, { from: 'l', to: 'other', strength: 0.9 });
    upsertEdge(brain, { from: 's', to: 'other', strength: 0.4 });
    upsertEdge(brain, { from: 's', to: 'l', strength: 0.7 }); // becomes a self-loop → dropped
    mergeNodes(brain, 's', 'l', 'Merged title', 'merged content');
    expect(brain.nodes.map((n) => n.id).sort()).toEqual(['other', 's']);
    expect(brain.edges).toHaveLength(1);
    expect(brain.edges[0].strength).toBe(0.9); // max(0.4, 0.9)
    expect(brain.nodes.find((n) => n.id === 's')!.title).toBe('Merged title');
  });
});

describe('runMergePass', () => {
  it('merges an LLM-confirmed near-duplicate pair', async () => {
    const brain = emptyBrain();
    upsertNode(brain, node('dup-a', { title: 'Restart docker with force-recreate', content: 'When the fleet looks offline, force-recreate the container instead of docker restart.' }));
    upsertNode(brain, node('dup-b', { title: 'Restart docker with force recreate', content: 'When the fleet looks offline, force recreate the container rather than docker restart.' }));
    upsertNode(brain, node('unrelated', { title: 'Wokwi pin naming', content: 'Cathode is C not K in wokwi diagrams.' }));
    const merged = await runMergePass(brain, async () => '{"merge": true, "title": "Force-recreate wedged containers", "content": "When the fleet looks offline, force-recreate."}');
    expect(merged).toBe(1);
    expect(brain.nodes).toHaveLength(2);
    expect(brain.nodes.some((n) => n.title === 'Force-recreate wedged containers')).toBe(true);
  });

  it('respects an LLM "merge": false verdict', async () => {
    const brain = emptyBrain();
    upsertNode(brain, node('dup-a', { title: 'Same words here about docker', content: 'docker docker docker compose restart' }));
    upsertNode(brain, node('dup-b', { title: 'Same words here about docker!', content: 'docker docker docker compose restart!' }));
    const merged = await runMergePass(brain, async () => '{"merge": false}');
    expect(merged).toBe(0);
    expect(brain.nodes).toHaveLength(2);
  });
});

describe('foldLeastUsed', () => {
  it('folds cold agent nodes into neighbours, preserving content and skipping seeds', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('hub', { category: 'core', origin: 'seed' }));
    for (let i = 0; i < 12; i++) upsertNode(brain, node(`n${i}`, { recallCount: i }));
    upsertEdge(brain, { from: 'n0', to: 'n11', strength: 0.9 });
    const before = brain.nodes.length;
    const folded = foldLeastUsed(brain, 0.25);
    expect(folded).toBeGreaterThan(0);
    expect(brain.nodes.length).toBe(before - folded);
    expect(brain.nodes.some((n) => n.id === 'hub')).toBe(true); // seed survives
    // n0 (coldest, edge to n11) folded into n11 with content appended.
    const n11 = brain.nodes.find((n) => n.id === 'n11');
    expect(n11?.content).toContain('content n0');
  });

  it('keeps a minimum floor of nodes', () => {
    const brain = emptyBrain();
    for (let i = 0; i < 5; i++) upsertNode(brain, node(`n${i}`));
    expect(foldLeastUsed(brain, 0.9)).toBe(0);
  });
});
