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

  it('clip nodes ride their own budget and never displace agent slots', () => {
    // 45 agent nodes (above bypass) all matching "docker", plus 10 clip nodes
    // that ALSO match: without the partition the clips would crowd the 12.
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 45; i++) nodes.push(node(`a${i}`, `Docker note ${i}`, `docker restart lesson ${i}`));
    for (let i = 0; i < 10; i++)
      nodes.push(
        node(`c${i}`, `Docker clip ${i}`, `docker restart clipped fact ${i}`, {
          origin: 'clip',
          sourceUrl: 'https://docs.docker.example/page',
        }),
      );
    const r = recallBrain({ nodes, edges: [] }, 'docker restart', { wholeGraphMax: 40 });
    const clipsIn = r.nodes.filter((n) => n.origin === 'clip');
    const agentIn = r.nodes.filter((n) => n.origin !== 'clip');
    expect(clipsIn.length).toBeLessThanOrEqual(3); // clipBudget
    expect(agentIn.length).toBeLessThanOrEqual(12); // clips never consume these
    expect(r.nodes.length).toBeLessThanOrEqual(15);
    // Clips come LAST and render as [clip] with their source host.
    expect(r.nodes[r.nodes.length - 1].origin).toBe('clip');
    expect(r.preamble).toMatch(/- \[clip\] Docker clip \d+:.*\(from docs\.docker\.example\)/);
  });

  it('the whole-graph bypass never injects the clip pool wholesale', () => {
    // 5 agent nodes (bypass fires) + 50 clips: only clipBudget clips may ride.
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 5; i++) nodes.push(node(`a${i}`, `Alpha ${i}`, `alpha ${i}`));
    for (let i = 0; i < 50; i++)
      nodes.push(node(`c${i}`, `Clip ${i}`, `clipped docker fact ${i}`, { origin: 'clip' }));
    const r = recallBrain({ nodes, edges: [] }, 'docker fact');
    expect(r.nodes.filter((n) => n.origin !== 'clip')).toHaveLength(5);
    expect(r.nodes.filter((n) => n.origin === 'clip').length).toBeLessThanOrEqual(3);
    expect(r.seedCount).toBe(5); // bypass semantics count only the agent side
  });

  it('a matching clip is injected even when no agent node matches', () => {
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 45; i++) nodes.push(node(`a${i}`, `Filler ${i}`, `unrelated ${i}`));
    nodes.push(node('the-clip', 'Webpack sourcemap trick', 'webpack devtool cheap-module fixes it', { origin: 'clip' }));
    const r = recallBrain({ nodes, edges: [] }, 'webpack sourcemap broken', { wholeGraphMax: 40 });
    expect(r.nodes.map((n) => n.id)).toEqual(['the-clip']);
    expect(r.seedCount).toBe(0);
    expect(r.preamble).toContain('[clip] Webpack sourcemap trick');
  });

  it('bumpRecall increments count and stamps lastRecalledAt', () => {
    const brain = { nodes: [node('a', 'A', 'a'), node('b', 'B', 'b')] };
    bumpRecall(brain, ['a'], new Date('2026-02-02T00:00:00Z'));
    expect(brain.nodes[0].recallCount).toBe(1);
    expect(brain.nodes[0].lastRecalledAt).toBe('2026-02-02T00:00:00.000Z');
    expect(brain.nodes[1].recallCount).toBe(0);
  });
});
