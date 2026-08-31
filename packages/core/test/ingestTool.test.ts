import { describe, expect, it } from 'vitest';
import {
  applyToolImport,
  buildToolImport,
  emptyBrain,
  toolNodeId,
  upsertNode,
  type BrainNode,
  type ToolInput,
} from '../src/index.js';

function fixtureTools(): ToolInput[] {
  return [
    { id: 'github', label: 'GitHub' },
    { id: 'stripe', label: 'Stripe' },
  ];
}

describe('buildToolImport', () => {
  it('builds one master node per tool, origin tool, with a toolRef bridge', () => {
    const { nodes } = buildToolImport(fixtureTools());
    expect(nodes).toHaveLength(2);
    const github = nodes.find((n) => n.id === toolNodeId('github'));
    expect(github?.title).toBe('GitHub');
    expect(github?.toolRef).toEqual({ tool: 'github', label: 'GitHub', kind: 'connection' });
    expect(nodes.every((n) => n.origin === 'tool')).toBe(true);
  });
});

describe('applyToolImport', () => {
  it('replaces every existing tool-origin node wholesale, leaving other origins untouched', () => {
    const brain = emptyBrain();
    const seed: BrainNode = {
      id: 'kept-seed',
      title: 'kept',
      category: 'core',
      content: 'curated',
      color: '#000',
      x: 0,
      y: 0,
      size: 16,
      origin: 'seed',
      lastUpdated: new Date(0).toISOString(),
      recallCount: 0,
    };
    upsertNode(brain, seed);

    const first = buildToolImport(fixtureTools());
    applyToolImport(brain, first);
    const firstCount = brain.nodes.filter((n) => n.origin === 'tool').length;
    expect(firstCount).toBe(2);

    // Re-sync with one fewer tool: old tool nodes must be gone, not accumulated.
    const second = buildToolImport([fixtureTools()[0]]);
    const { removed } = applyToolImport(brain, second);

    expect(removed).toBe(firstCount);
    expect(brain.nodes.filter((n) => n.origin === 'tool')).toHaveLength(1);
    expect(brain.nodes.find((n) => n.id === 'kept-seed')).toBeTruthy();
    expect(brain.nodes.find((n) => n.id === toolNodeId('stripe'))).toBeUndefined();
  });
});
