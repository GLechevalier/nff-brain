import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyImport,
  emptyBrain,
  emptyImportState,
  loadImportState,
  nodeDegree,
  recordProposalHashes,
  recordSession,
  saveImportState,
  seenProposalHashes,
  skippableSessionIds,
  upsertNode,
  type BrainFile,
  type BrainNode,
  type PendingItem,
} from '../src/index.js';

function item(over: Partial<PendingItem> = {}): PendingItem {
  return {
    key: 'm1',
    id: 'a-lesson',
    status: 'new',
    kind: 'memory',
    category: 'strategy',
    title: 'A lesson',
    content: 'When X happens, do Y because Z.',
    confidence: 0.8,
    checked: true,
    sources: [{ sessionId: 's1', title: 't', date: '2026-08-01' }],
    hash: 'memory:a-lesson',
    ...over,
  };
}

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: 'Existing content.',
    color: '#a78bfa',
    x: 10,
    y: 20,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-08-01T00:00:00.000Z',
    recallCount: 5,
    ...extra,
  };
}

function brainWith(...nodes: BrainNode[]): BrainFile {
  const b = emptyBrain();
  for (const n of nodes) upsertNode(b, n);
  return b;
}

describe('applyImport', () => {
  it('creates nodes with origin import, confidence and provenance', () => {
    const brain = emptyBrain();
    const r = applyImport(brain, [item()]);
    expect(r.created).toEqual(['a-lesson']);
    const n = brain.nodes[0];
    expect(n.origin).toBe('import');
    expect(n.confidence).toBe(0.8);
    expect(n.importedFrom).toEqual(['s1']);
    expect(n.sourceSession).toBe('s1');
  });

  it('caps importedFrom at five sessions', () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ sessionId: `s${i}`, title: null, date: null }));
    const brain = emptyBrain();
    applyImport(brain, [item({ sources })]);
    expect(brain.nodes[0].importedFrom).toHaveLength(5);
  });

  it('refining keeps the target place, recallCount and ORIGIN', () => {
    // Refining a hand-curated seed must not demote it to an import, or it
    // becomes evictable and loses its protection.
    const brain = brainWith(node('a-lesson', { origin: 'seed', x: 111, y: 222 }));
    const r = applyImport(brain, [item({ status: 'refine', targetId: 'a-lesson' })]);
    expect(r.refined).toEqual(['a-lesson']);
    expect(r.created).toEqual([]);
    const n = brain.nodes[0];
    expect(n.origin).toBe('seed');
    expect(n.x).toBe(111);
    expect(n.recallCount).toBe(5);
    expect(n.content).toBe('When X happens, do Y because Z.'); // text did update
  });

  it('reports cap overflow instead of silently dropping it', () => {
    const items = Array.from({ length: 5 }, (_, i) => item({ key: `m${i}`, id: `lesson-${i}` }));
    const brain = emptyBrain();
    const r = applyImport(brain, items, { maxNewNodes: 3 });
    expect(r.created).toHaveLength(3);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.every((s) => s.reason === 'cap')).toBe(true);
  });

  it('a refine does not consume the new-node budget', () => {
    const brain = brainWith(node('a-lesson'));
    const r = applyImport(brain, [item({ status: 'refine', targetId: 'a-lesson' }), item({ key: 'm2', id: 'brand-new' })], {
      maxNewNodes: 1,
    });
    expect(r.refined).toEqual(['a-lesson']);
    expect(r.created).toEqual(['brand-new']);
    expect(r.skipped).toEqual([]);
  });

  it('rejects an item with no title or body', () => {
    const brain = emptyBrain();
    const r = applyImport(brain, [item({ content: '   ' })]);
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toBe('invalid');
  });

  it('links items that came from the same session', () => {
    const brain = emptyBrain();
    const shared = [{ sessionId: 's1', title: 't', date: null }];
    applyImport(brain, [
      item({ key: 'm1', id: 'one', sources: shared }),
      item({ key: 'm2', id: 'two', sources: shared }),
    ]);
    const edge = brain.edges.find(
      (e) => (e.from === 'one' && e.to === 'two') || (e.from === 'two' && e.to === 'one'),
    );
    expect(edge).toBeDefined();
    expect(edge!.strength).toBeCloseTo(0.35, 2);
  });

  it('strengthens the link when items share several sessions', () => {
    const shared = [
      { sessionId: 's1', title: null, date: null },
      { sessionId: 's2', title: null, date: null },
      { sessionId: 's3', title: null, date: null },
    ];
    const brain = emptyBrain();
    applyImport(brain, [item({ id: 'one', sources: shared }), item({ key: 'm2', id: 'two', sources: shared })]);
    expect(brain.edges[0].strength).toBeCloseTo(0.65, 2);
  });

  it('caps provenance edges so one big session cannot emit a clique', () => {
    const shared = [{ sessionId: 's1', title: null, date: null }];
    const items = Array.from({ length: 12 }, (_, i) => item({ key: `m${i}`, id: `n${i}`, sources: shared }));
    const brain = emptyBrain();
    applyImport(brain, items);
    // 12 nodes fully connected would be 66 edges; the cap keeps it far below.
    expect(brain.edges.length).toBeLessThanOrEqual(12 * 4);
    expect(brain.edges.length).toBeLessThan(66);
  });

  it('hangs an orphan off the hub so the graph stays one structure', () => {
    const brain = brainWith(node('hub', { category: 'core', origin: 'seed', content: 'Central hub for the project.' }));
    applyImport(brain, [item({ id: 'lonely', content: 'Utterly unrelated subject matter about zebras.' })]);
    const edge = brain.edges.find((e) => e.from === 'lonely' && e.to === 'hub');
    expect(edge?.strength).toBe(0.3);
  });

  it('does not add a hub edge to a node that already has one', () => {
    const brain = brainWith(node('hub', { category: 'core' }));
    const shared = [{ sessionId: 's1', title: null, date: null }];
    applyImport(brain, [item({ id: 'one', sources: shared }), item({ key: 'm2', id: 'two', sources: shared })]);
    expect(nodeDegree(brain, 'one')).toBe(1); // its sibling, not the hub
    expect(brain.edges.some((e) => e.to === 'hub')).toBe(false);
  });

  it('links a new node to a textually similar existing one', () => {
    const brain = brainWith(
      node('win-rename', {
        title: 'Retry renameSync on Windows EPERM',
        content: 'Defender briefly locks the destination, so the atomic save must retry the rename.',
      }),
    );
    applyImport(brain, [
      item({
        id: 'atomic-save-retry',
        title: 'Retry renameSync on Windows EPERM errors',
        content: 'Defender briefly locks the destination file, so the atomic save retries the rename.',
      }),
    ]);
    expect(brain.edges.some((e) => e.from === 'atomic-save-retry' && e.to === 'win-rename')).toBe(true);
  });

  it('handles an empty item list', () => {
    const brain = emptyBrain();
    const r = applyImport(brain, []);
    expect(r).toEqual({ created: [], refined: [], skipped: [], edges: 0 });
  });

  it('is idempotent — applying twice creates no duplicates', () => {
    const brain = emptyBrain();
    applyImport(brain, [item()]);
    const first = brain.nodes.length;
    applyImport(brain, [item()]);
    expect(brain.nodes).toHaveLength(first);
  });
});

describe('import ledger', () => {
  let dir: string;
  let brainPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-ledger-'));
    brainPath = path.join(dir, '.nff-brain', 'brain.json');
    fs.mkdirSync(path.dirname(brainPath), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips through disk', () => {
    const s = emptyImportState();
    recordSession(s, 'sess-1', { bytes: 1234, mtimeMs: 99, produced: ['a'] });
    recordProposalHashes(s, ['memory:one', 'decision:two']);
    s.lastRunAt = '2026-08-11T00:00:00.000Z';
    saveImportState(brainPath, s);

    const back = loadImportState(brainPath);
    expect(back.sessions['sess-1'].bytes).toBe(1234);
    expect([...seenProposalHashes(back)].sort()).toEqual(['decision:two', 'memory:one']);
    expect(back.lastRunAt).toBe('2026-08-11T00:00:00.000Z');
  });

  it('treats a missing or corrupt ledger as empty rather than fatal', () => {
    expect(loadImportState(brainPath).sessions).toEqual({});
    fs.writeFileSync(path.join(dir, '.nff-brain', 'import-state.json'), '{not json');
    expect(loadImportState(brainPath)).toEqual(emptyImportState());
  });

  it('skips a mined session but re-reads one that GREW', () => {
    const s = emptyImportState();
    recordSession(s, 'same', { bytes: 100, mtimeMs: 1 });
    recordSession(s, 'grew', { bytes: 100, mtimeMs: 1 });
    const sizes = new Map([
      ['same', 100],
      ['grew', 5000], // resumed, so there is new material in it
    ]);
    const skip = skippableSessionIds(s, sizes);
    expect(skip.has('same')).toBe(true);
    expect(skip.has('grew')).toBe(false);
  });

  it('does not double-record a hash and trims the oldest past the cap', () => {
    const s = emptyImportState();
    recordProposalHashes(s, ['a', 'b']);
    recordProposalHashes(s, ['b', 'c']);
    expect(s.proposalHashes).toEqual(['a', 'b', 'c']);

    recordProposalHashes(s, Array.from({ length: 2100 }, (_, i) => `h${i}`));
    expect(s.proposalHashes).toHaveLength(2000);
    expect(s.proposalHashes).not.toContain('a'); // oldest fell off
    expect(s.proposalHashes).toContain('h2099');
  });
});
