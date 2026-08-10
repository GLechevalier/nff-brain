import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrainVersionError,
  emptyBrain,
  loadBrain,
  mergeBrains,
  mutateBrain,
  removeNode,
  saveBrain,
  upsertEdge,
  upsertNode,
} from '../src/index.js';
import type { BrainFile, BrainNode } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: `content of ${id}`,
    color: '#a78bfa',
    x: 100,
    y: 100,
    size: 16,
    origin: 'agent',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
    ...extra,
  };
}

describe('store', () => {
  it('round-trips a brain file atomically (creating parent dirs)', () => {
    const p = path.join(dir, '.nff-brain', 'brain.json');
    const brain = emptyBrain();
    upsertNode(brain, node('a'));
    saveBrain(p, brain);
    const loaded = loadBrain(p);
    expect(loaded?.nodes.map((n) => n.id)).toEqual(['a']);
    // No temp files left behind.
    expect(fs.readdirSync(path.dirname(p)).filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('returns null for a missing file', () => {
    expect(loadBrain(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('refuses files with a newer schema version', () => {
    const p = path.join(dir, 'brain.json');
    fs.writeFileSync(p, JSON.stringify({ version: 99, nodes: [], edges: [] }));
    expect(() => loadBrain(p)).toThrow(BrainVersionError);
  });

  it('mutateBrain creates an empty brain when missing and persists the mutation', () => {
    const p = path.join(dir, 'brain.json');
    mutateBrain(p, (b) => upsertNode(b, node('x')));
    expect(loadBrain(p)?.nodes).toHaveLength(1);
    // Lock cleaned up.
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
  });

  it('steals a stale lock', () => {
    const p = path.join(dir, 'brain.json');
    fs.mkdirSync(`${p}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${p}.lock`, old, old);
    mutateBrain(p, (b) => upsertNode(b, node('y')));
    expect(loadBrain(p)?.nodes).toHaveLength(1);
  });

  it('upsertEdge overwrites strength regardless of direction', () => {
    const b = emptyBrain();
    upsertEdge(b, { from: 'a', to: 'b', strength: 0.5 });
    upsertEdge(b, { from: 'b', to: 'a', strength: 0.9 });
    expect(b.edges).toHaveLength(1);
    expect(b.edges[0].strength).toBe(0.9);
  });

  it('removeNode drops touching edges', () => {
    const b = emptyBrain();
    upsertNode(b, node('a'));
    upsertNode(b, node('b'));
    upsertEdge(b, { from: 'a', to: 'b', strength: 0.6 });
    removeNode(b, 'a');
    expect(b.nodes.map((n) => n.id)).toEqual(['b']);
    expect(b.edges).toHaveLength(0);
  });

  it('mergeBrains: project wins on id collision, edges filtered to present nodes', () => {
    const project: BrainFile = { ...emptyBrain(), nodes: [node('a', { title: 'project-a' }), node('b')] };
    const global: BrainFile = {
      ...emptyBrain(),
      nodes: [node('a', { title: 'global-a' }), node('g')],
      edges: [
        { from: 'a', to: 'g', strength: 0.7 },
        { from: 'g', to: 'missing', strength: 0.7 },
      ],
    };
    const merged = mergeBrains(project, global);
    expect(merged.nodes.find((n) => n.id === 'a')?.title).toBe('project-a');
    expect(merged.sourceById.get('a')).toBe('project');
    expect(merged.sourceById.get('g')).toBe('global');
    expect(merged.edges).toEqual([{ from: 'a', to: 'g', strength: 0.7 }]);
  });
});
