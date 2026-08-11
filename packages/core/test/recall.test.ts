import { describe, expect, it } from 'vitest';
import { bumpRecall, recallBrain, scoreNode, tokenize, trigramSim } from '../src/index.js';
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

describe('score', () => {
  it('tokenize drops stopwords and short tokens', () => {
    const t = tokenize('The quick fox and a dog use MQTT');
    expect(t.has('the')).toBe(false);
    expect(t.has('quick')).toBe(true);
    expect(t.has('mqtt')).toBe(true);
  });

  it('trigramSim is 1 for identical strings, ~0 for disjoint', () => {
    expect(trigramSim('docker compose restart', 'docker compose restart')).toBe(1);
    expect(trigramSim('abcdef', 'zzz-yyy')).toBeLessThan(0.1);
  });

  it('scoreNode ranks a matching node above an unrelated one', () => {
    const hit = node('a', 'Docker restart procedure', 'When containers wedge, force-recreate them');
    const miss = node('b', 'Color palette', 'Buttons are monochrome');
    const q = 'my docker container is wedged, how do I restart';
    expect(scoreNode(q, hit)).toBeGreaterThan(scoreNode(q, miss));
  });
});

describe('recallBrain', () => {
  it('injects the whole graph at/below wholeGraphMax', () => {
    const nodes = [node('a', 'Alpha', 'aaa'), node('b', 'Beta', 'bbb')];
    const edges: BrainEdge[] = [{ from: 'a', to: 'b', strength: 0.8 }];
    const r = recallBrain({ nodes, edges }, 'anything at all');
    expect(r.nodes).toHaveLength(2);
    expect(r.seedCount).toBe(2); // whole-graph bypass: everything is a "seed"
    expect(r.preamble).toContain('## Your learned skills & playbooks');
    expect(r.preamble).toContain('- [strategy] Alpha: aaa');
    expect(r.preamble).toContain('↳ related: Beta');
    expect(r.preamble.trimEnd().endsWith('---')).toBe(true);
  });

  it('seeds lexically and expands along strongest edges above the bypass size', () => {
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 50; i++) nodes.push(node(`filler-${i}`, `Filler ${i}`, `unrelated text ${i}`));
    nodes.push(node('docker-fix', 'Docker DNS wedge', 'When fleet looks offline, force-recreate the container'));
    nodes.push(node('neighbor', 'Compose env gotcha', 'env leaks C:/data into compose'));
    const edges: BrainEdge[] = [{ from: 'docker-fix', to: 'neighbor', strength: 0.9 }];
    const r = recallBrain({ nodes, edges }, 'the docker fleet looks offline again', { wholeGraphMax: 40 });
    const ids = r.nodes.map((n) => n.id);
    expect(ids).toContain('docker-fix');
    expect(ids).toContain('neighbor'); // pulled in by the edge, not the text
    expect(r.nodes.length).toBeLessThanOrEqual(12);
    // Seeds come first; the edge-expanded neighbor sits past seedCount.
    expect(r.seedCount).toBeGreaterThan(0);
    expect(r.seedCount).toBeLessThanOrEqual(6);
    expect(ids.indexOf('neighbor')).toBeGreaterThanOrEqual(r.seedCount);
  });

  it('returns empty when nothing matches (above bypass size)', () => {
    const nodes = Array.from({ length: 45 }, (_, i) => node(`n${i}`, `Node ${i}`, `alpha beta ${i}`));
    const r = recallBrain({ nodes, edges: [] }, 'zzzzqqqq xxyyzz', { wholeGraphMax: 40 });
    expect(r.preamble).toBe('');
    expect(r.nodes).toHaveLength(0);
  });

  it('bumpRecall increments count and stamps lastRecalledAt', () => {
    const brain = { nodes: [node('a', 'A', 'a'), node('b', 'B', 'b')] };
    bumpRecall(brain, ['a'], new Date('2026-02-02T00:00:00Z'));
    expect(brain.nodes[0].recallCount).toBe(1);
    expect(brain.nodes[0].lastRecalledAt).toBe('2026-02-02T00:00:00.000Z');
    expect(brain.nodes[1].recallCount).toBe(0);
  });
});
