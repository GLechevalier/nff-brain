import { describe, expect, it } from 'vitest';
import {
  approxTokens,
  brainSavings,
  eventSavings,
  formatTokens,
  injectionTokens,
  rediscoveryTokens,
  SAVINGS_MODEL,
  savedPerInjection,
} from '../src/index.js';
import type { ActivityEvent, BrainNode } from '../src/index.js';

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: 'x'.repeat(200),
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

function graphifyNode(id: string, children: number, extra: Partial<BrainNode> = {}): BrainNode {
  return node(id, {
    origin: 'graphify',
    graphifyRef: {
      graph: 'graphify-out/graph.json',
      kind: 'community',
      key: 1,
      children: Array.from({ length: children }, (_, i) => `gf-${i}`),
    },
    ...extra,
  });
}

describe('savings estimator', () => {
  it('prices an injection with the same 600-char trim recall applies', () => {
    const short = node('short', { content: 'y'.repeat(100) });
    const long = node('long', { content: 'y'.repeat(5000) });
    expect(injectionTokens(long)).toBeGreaterThan(injectionTokens(short));
    // A 5000-char node still only costs its trimmed 600 chars in the preamble.
    expect(injectionTokens(long)).toBeLessThan(approxTokens('y'.repeat(700)) + 100);
  });

  it('rediscovery cost depends on origin', () => {
    expect(rediscoveryTokens(node('a', { origin: 'agent' }))).toBe(SAVINGS_MODEL.rediscoverAgentTokens);
    expect(rediscoveryTokens(node('s', { origin: 'seed' }))).toBe(SAVINGS_MODEL.rediscoverSeedTokens);
    expect(rediscoveryTokens(node('c', { origin: 'clip' }))).toBe(SAVINGS_MODEL.rediscoverClipTokens);
    expect(rediscoveryTokens(graphifyNode('g', 4))).toBe(4 * SAVINGS_MODEL.graphifyPerChildTokens);
  });

  it('clip savings land in their own byOrigin bucket', () => {
    const s = brainSavings([node('c', { origin: 'clip', recallCount: 2 })]);
    expect(s.byOrigin.clip).toBeGreaterThan(0);
    expect(s.byOrigin.agent).toBe(0);
  });

  it('caps a fat codebase-map node instead of letting it dominate', () => {
    expect(rediscoveryTokens(graphifyNode('big', 45))).toBe(SAVINGS_MODEL.graphifyMaxTokens);
  });

  it('a graphify node with no children claims nothing', () => {
    expect(savedPerInjection(node('empty', { origin: 'graphify' }))).toBe(0);
  });

  it('never goes negative when the node costs more than it saves', () => {
    const bloated = node('bloated', { origin: 'seed', content: 'z'.repeat(600) });
    expect(rediscoveryTokens(bloated)).toBeLessThan(injectionTokens(bloated) + SAVINGS_MODEL.rediscoverSeedTokens);
    expect(savedPerInjection(bloated)).toBeGreaterThanOrEqual(0);
    const tiny = node('tiny', { origin: 'graphify' });
    expect(savedPerInjection(tiny)).toBe(0);
  });

  it('brainSavings is zero until nodes have actually been recalled', () => {
    const s = brainSavings([node('a'), graphifyNode('b', 10)]);
    expect(s.total).toBe(0);
    expect(s.injections).toBe(0);
  });

  it('brainSavings scales with recallCount and splits by origin', () => {
    const nodes = [node('a', { recallCount: 3 }), graphifyNode('g', 10, { recallCount: 2 })];
    const s = brainSavings(nodes);
    expect(s.injections).toBe(5);
    expect(s.total).toBe(3 * savedPerInjection(nodes[0]) + 2 * savedPerInjection(nodes[1]));
    expect(s.byOrigin.agent).toBe(3 * savedPerInjection(nodes[0]));
    expect(s.byOrigin.graphify).toBe(2 * savedPerInjection(nodes[1]));
    expect(s.byOrigin.seed).toBe(0);
  });

  it('eventSavings counts recall only, discounting edge-expanded nodes', () => {
    const a = node('a');
    const b = node('b');
    const byId = new Map([a, b].map((n) => [n.id, n]));
    const at = '2026-01-01T00:00:00.000Z';

    const seedsOnly: ActivityEvent = { v: 1, at, kind: 'recall', ids: ['a', 'b'], seedCount: 2 };
    const oneExpanded: ActivityEvent = { v: 1, at, kind: 'recall', ids: ['a', 'b'], seedCount: 1 };
    expect(eventSavings([seedsOnly], byId)).toBeGreaterThan(eventSavings([oneExpanded], byId));
    expect(eventSavings([seedsOnly], byId)).toBe(2 * savedPerInjection(a));

    for (const kind of ['prompt', 'distill', 'search', 'expand'] as const) {
      expect(eventSavings([{ v: 1, at, kind, ids: ['a', 'b'] }], byId)).toBe(0);
    }
  });

  it('eventSavings ignores ids that are no longer in the graph', () => {
    const byId = new Map<string, BrainNode>();
    const e: ActivityEvent = { v: 1, at: '2026-01-01T00:00:00.000Z', kind: 'recall', ids: ['gone'], seedCount: 1 };
    expect(eventSavings([e], byId)).toBe(0);
  });

  it('formatTokens stays short at every magnitude', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(840)).toBe('840');
    expect(formatTokens(8_400)).toBe('8.4k');
    expect(formatTokens(412_000)).toBe('412k');
    expect(formatTokens(1_040_000)).toBe('1.0M');
    expect(formatTokens(-5)).toBe('0');
  });
});
