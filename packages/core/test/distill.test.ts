import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  buildDistillPrompt,
  distill,
  emptyBrain,
  extractJson,
  pruneBrain,
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

describe('extractJson', () => {
  it('parses fenced / prosey output', () => {
    const raw = 'Sure! Here is the JSON:\n```json\n{"nodes":[],"edges":[]}\n```\nHope that helps.';
    expect(extractJson(raw)).toEqual({ nodes: [], edges: [] });
  });
  it('returns null on garbage', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{broken')).toBeNull();
  });
});

describe('applyDelta', () => {
  it('creates capped new nodes, refines by id, validates edge endpoints', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('known-node', { title: 'Old title', recallCount: 5, x: 42, y: 43 }));

    const written = applyDelta(
      brain,
      {
        nodes: [
          { id: 'known-node', title: 'Refined title', category: 'rules', content: 'refined content' },
          { id: 'new-one', title: 'New one', category: 'analysis', content: 'aaa' },
          { id: 'new-two', title: 'New two', category: 'strategy', content: 'bbb' },
          { id: 'new-three', title: 'New three', category: 'strategy', content: 'ccc' },
        ],
        edges: [
          { from: 'new-one', to: 'known-node', strength: 0.8 },
          { from: 'new-one', to: 'ghost', strength: 0.8 },
          { from: 'new-one', to: 'new-one', strength: 0.8 },
        ],
      },
      { maxNewNodes: 2, sessionId: 'sess-1' },
    );

    // 1 refine + 2 new (third new dropped by the cap)
    expect(written.size).toBe(3);
    expect(brain.nodes).toHaveLength(3);
    const refined = brain.nodes.find((n) => n.id === 'known-node')!;
    expect(refined.title).toBe('Refined title');
    expect(refined.category).toBe('rules');
    expect(refined.recallCount).toBe(5); // preserved
    expect(refined.x).toBe(42); // refine keeps its place on the board
    // Only the edge with two real endpoints survives.
    expect(brain.edges).toEqual([{ from: 'new-one', to: 'known-node', strength: 0.8 }]);
  });

  it('slugs ids and skips empty nodes', () => {
    const brain = emptyBrain();
    applyDelta(
      brain,
      { nodes: [{ id: 'Weird ID!! Here', title: 'T', content: 'c' }, { title: '', content: 'x' }] },
      { maxNewNodes: 5 },
    );
    expect(brain.nodes.map((n) => n.id)).toEqual(['weird-id-here']);
  });
});

describe('distill', () => {
  it('runs the oneShot and applies the parsed delta', async () => {
    const brain = emptyBrain();
    let seenPrompt = '';
    const ids = await distill(brain, {
      taskText: 'fix the flaky test',
      transcript: '[user] hello',
      oneShot: async (p) => {
        seenPrompt = p;
        return '{"nodes":[{"id":"lesson-1","title":"Lesson","category":"rules","content":"When X do Y"}],"edges":[]}';
      },
    });
    expect([...ids]).toEqual(['lesson-1']);
    expect(seenPrompt).toContain('memory distiller');
    expect(seenPrompt).toContain('fix the flaky test');
  });

  it('writes nothing when the LLM output has no JSON', async () => {
    const brain = emptyBrain();
    const ids = await distill(brain, { taskText: 't', transcript: '', oneShot: async () => 'nothing useful' });
    expect(ids.size).toBe(0);
    expect(brain.nodes).toHaveLength(0);
  });
});

describe('pruneBrain', () => {
  it('evicts lowest-value agent nodes, never seeds', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('seed', { origin: 'seed', recallCount: 0 }));
    upsertNode(brain, node('hot', { recallCount: 9 }));
    upsertNode(brain, node('cold', { recallCount: 0 }));
    upsertNode(brain, node('warm', { recallCount: 3 }));
    const evicted = pruneBrain(brain, 3);
    expect(evicted).toBe(1);
    expect(brain.nodes.map((n) => n.id).sort()).toEqual(['hot', 'seed', 'warm']);
  });

  it('graphify nodes are never victims and do not count toward the budget', () => {
    const brain = emptyBrain();
    // 3 graphify + 3 agent nodes with a cap of 3: the graphify nodes neither
    // trigger eviction (countable = 3) nor get evicted themselves.
    for (let i = 0; i < 3; i++) upsertNode(brain, node(`map${i}`, { origin: 'graphify', recallCount: 0 }));
    for (let i = 0; i < 3; i++) upsertNode(brain, node(`n${i}`, { recallCount: i }));
    expect(pruneBrain(brain, 3)).toBe(0);
    // One agent node over the cap: exactly one agent node goes, graphify stays.
    upsertNode(brain, node('n3', { recallCount: 9 }));
    expect(pruneBrain(brain, 3)).toBe(1);
    expect(brain.nodes.filter((n) => n.origin === 'graphify')).toHaveLength(3);
    expect(brain.nodes.some((n) => n.id === 'n0')).toBe(false); // coldest agent evicted
  });
});

describe('buildDistillPrompt', () => {
  it('lists known nodes and caps the transcript', () => {
    const p = buildDistillPrompt({
      taskText: 'task',
      transcript: 'x'.repeat(20_000),
      knownNodes: [node('k1', { title: 'Known one' })],
      maxNewNodes: 3,
      maxTranscriptChars: 100,
    });
    expect(p).toContain('id="k1"');
    expect(p).toContain('At most 3 NEW nodes');
    expect(p.length).toBeLessThan(2_500);
  });
});
