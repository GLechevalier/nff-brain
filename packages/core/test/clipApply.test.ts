import { describe, expect, it } from 'vitest';
import { MAX_CLIP_NODES, applyClips, emptyBrain, pruneClips, upsertNode } from '../src/index.js';
import type { BrainNode, ClipProposal, ClipRecord } from '../src/index.js';

function clip(id: string, extra: Partial<ClipRecord> = {}): ClipRecord {
  return {
    v: 1,
    id,
    at: '2026-08-11T00:00:00.000Z',
    kind: 'selection',
    text: `text of ${id}`,
    target: 'global',
    source: 'chrome',
    ...extra,
  };
}

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

function proposal(title: string, clipIds: string[], extra: Partial<ClipProposal> = {}): ClipProposal {
  return { category: 'strategy', title, content: `content of ${title}`, clipIds, ...extra };
}

describe('applyClips', () => {
  it('mints origin clip nodes with sourceUrl and returns the clip→node map', () => {
    const brain = emptyBrain();
    const c = clip('clp_1', { url: 'https://docs.example.com/page' });
    const result = applyClips(brain, [proposal('OAuth Callback Rule', ['clp_1'])], [], new Map([['clp_1', c]]));

    expect(result.created).toEqual(['oauth-callback-rule']);
    const minted = brain.nodes[0];
    expect(minted.origin).toBe('clip');
    expect(minted.sourceUrl).toBe('https://docs.example.com/page');
    expect(result.byClip.get('clp_1')).toEqual(['oauth-callback-rule']);
  });

  it('never overwrites a node of another origin — collisions get a suffixed id', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('my-lesson', { origin: 'agent', content: 'agent knowledge' }));
    const c = clip('clp_1');
    const result = applyClips(brain, [proposal('My Lesson', ['clp_1'])], [], new Map([['clp_1', c]]));

    expect(result.created).toEqual(['my-lesson-clip']);
    expect(brain.nodes.find((n) => n.id === 'my-lesson')!.content).toBe('agent knowledge');
    expect(brain.nodes.find((n) => n.id === 'my-lesson-clip')!.origin).toBe('clip');
  });

  it('refines an existing clip node in place, keeping its position and recallCount', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('re-captured', { origin: 'clip', x: 42, recallCount: 7, sourceUrl: 'https://a.example' }));
    const c = clip('clp_2');
    const result = applyClips(brain, [proposal('Re Captured', ['clp_2'])], [], new Map([['clp_2', c]]));

    expect(result.refined).toEqual(['re-captured']);
    expect(result.created).toHaveLength(0);
    const n = brain.nodes.find((x) => x.id === 're-captured')!;
    expect(n.x).toBe(42);
    expect(n.recallCount).toBe(7);
    expect(n.sourceUrl).toBe('https://a.example'); // kept when the new batch has none
  });

  it('links same-host clips together and orphans to the hub', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('hub', { category: 'core', origin: 'seed' }));
    const c1 = clip('clp_1', { url: 'https://site.example.com/a' });
    const c2 = clip('clp_2', { url: 'https://site.example.com/b' });
    const clipsById = new Map([
      ['clp_1', c1],
      ['clp_2', c2],
    ]);
    applyClips(
      brain,
      [proposal('First Fact zq', ['clp_1']), proposal('Second Fact wx', ['clp_2'])],
      [],
      clipsById,
    );
    const pair = brain.edges.find(
      (e) =>
        (e.from === 'first-fact-zq' && e.to === 'second-fact-wx') ||
        (e.from === 'second-fact-wx' && e.to === 'first-fact-zq'),
    );
    expect(pair).toBeDefined();
    expect(pair!.strength).toBe(0.5);
  });

  it('maps duplicates onto the existing clip node — but only when it IS a clip node', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('old-clip', { origin: 'clip' }));
    upsertNode(brain, node('agent-node', { origin: 'agent' }));
    const c = clip('clp_1');
    const result = applyClips(
      brain,
      [],
      [
        { clipId: 'clp_1', of: 'old-clip' },
        { clipId: 'clp_1', of: 'agent-node' }, // poisoned: must be ignored
      ],
      new Map([['clp_1', c]]),
    );
    expect(result.byClip.get('clp_1')).toEqual(['old-clip']);
  });
});

describe('pruneClips', () => {
  it('evicts only clip nodes, coldest first, and returns the evicted ids', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('agent-cold', { origin: 'agent', recallCount: 0 }));
    upsertNode(brain, node('clip-cold', { origin: 'clip', recallCount: 0 }));
    upsertNode(brain, node('clip-warm', { origin: 'clip', recallCount: 3 }));
    upsertNode(brain, node('clip-hot', { origin: 'clip', recallCount: 9 }));
    brain.edges.push({ from: 'clip-cold', to: 'clip-hot', strength: 0.5 });

    const evicted = pruneClips(brain, 2);
    expect(evicted).toEqual(['clip-cold']);
    expect(brain.nodes.some((n) => n.id === 'agent-cold')).toBe(true); // untouched
    expect(brain.edges).toHaveLength(0); // touching edges went with the victim
  });

  it('is a no-op at or under the cap', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('c1', { origin: 'clip' }));
    expect(pruneClips(brain)).toEqual([]);
    expect(MAX_CLIP_NODES).toBe(60);
  });
});
