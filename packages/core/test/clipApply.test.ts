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

  it('mints origin pagevisit when every folded clip is a page visit', () => {
    const brain = emptyBrain();
    const c = clip('clp_1', { kind: 'pagevisit', url: 'https://docs.example.com/read' });
    const result = applyClips(brain, [proposal('Read Later', ['clp_1'])], [], new Map([['clp_1', c]]));

    expect(result.created).toEqual(['read-later']);
    expect(brain.nodes[0].origin).toBe('pagevisit');
  });

  it('defaults a mixed clip+pagevisit fold to origin clip (the more-protected tier)', () => {
    const brain = emptyBrain();
    const c1 = clip('clp_1', { kind: 'selection' });
    const c2 = clip('clp_2', { kind: 'pagevisit' });
    const clipsById = new Map([
      ['clp_1', c1],
      ['clp_2', c2],
    ]);
    const result = applyClips(brain, [proposal('Mixed Fold', ['clp_1', 'clp_2'])], [], clipsById);
    expect(brain.nodes.find((n) => n.id === result.created[0])!.origin).toBe('clip');
  });

  it('does not refine an existing clip-origin node from a pagevisit proposal at the same slug', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('same-slug', { origin: 'clip', recallCount: 5 }));
    const c = clip('clp_1', { kind: 'pagevisit' });
    const result = applyClips(brain, [proposal('Same Slug', ['clp_1'])], [], new Map([['clp_1', c]]));

    expect(result.created).toEqual(['same-slug-clip']);
    expect(result.refined).toHaveLength(0);
    expect(brain.nodes.find((n) => n.id === 'same-slug')!.recallCount).toBe(5); // untouched
    expect(brain.nodes.find((n) => n.id === 'same-slug-clip')!.origin).toBe('pagevisit');
  });

  it('maps duplicates onto an existing pagevisit node too', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('old-visit', { origin: 'pagevisit' }));
    const c = clip('clp_1', { kind: 'pagevisit' });
    const result = applyClips(
      brain,
      [],
      [{ clipId: 'clp_1', of: 'old-visit' }],
      new Map([['clp_1', c]]),
    );
    expect(result.byClip.get('clp_1')).toEqual(['old-visit']);
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
    // 200, not 60: standalone mode's whole brain is clip-origin, and a migrated
    // standalone brain must survive /v1/import without immediate eviction.
    expect(MAX_CLIP_NODES).toBe(200);
  });

  it('prunes only the given origin, leaving the other pool untouched', () => {
    const brain = emptyBrain();
    upsertNode(brain, node('clip-cold', { origin: 'clip', recallCount: 0 }));
    upsertNode(brain, node('visit-cold', { origin: 'pagevisit', recallCount: 0 }));
    upsertNode(brain, node('visit-warm', { origin: 'pagevisit', recallCount: 5 }));

    const evicted = pruneClips(brain, 1, 'pagevisit');
    expect(evicted).toEqual(['visit-cold']);
    expect(brain.nodes.some((n) => n.id === 'clip-cold')).toBe(true); // untouched — different origin
    expect(brain.nodes.some((n) => n.id === 'visit-warm')).toBe(true);
  });
});
