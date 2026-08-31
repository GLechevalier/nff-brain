import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkoutBrain,
  commitBrain,
  createBranch,
  loadBrain,
  loadCommits,
  loadRefs,
  mergeBranch,
  saveBrain,
  upsertNode,
  type BrainNode,
} from '../src/index.js';

let dir: string;
let brainPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-version-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
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
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
    ...extra,
  };
}

describe('commitBrain', () => {
  it('is a no-op when brain.json matches HEAD', async () => {
    const brain = { version: 1 as const, updatedAt: '', nodes: [], edges: [] };
    saveBrain(brainPath, brain);
    const commit = await commitBrain(brainPath, { author: 'alice' });
    expect(commit).toBeNull();
    expect(loadCommits(brainPath)).toEqual([]);
  });

  it('diffs against HEAD and advances the current branch', async () => {
    const brain = { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] };
    saveBrain(brainPath, brain);
    const commit = await commitBrain(brainPath, { author: 'alice', message: 'add a' });
    expect(commit?.message).toBe('add a');
    expect(commit?.parents).toEqual([]);

    const refs = loadRefs(brainPath);
    expect(refs.branches.main).toBe(commit?.id);
    expect(refs.HEAD).toBe('main');

    // A second commit chains onto the first.
    const brain2 = loadBrain(brainPath)!;
    upsertNode(brain2, node('b'));
    saveBrain(brainPath, brain2);
    const commit2 = await commitBrain(brainPath, { author: 'alice', message: 'add b' });
    expect(commit2?.parents).toEqual([commit?.id]);
    expect(loadCommits(brainPath)).toHaveLength(2);
  });

  it('falls back to a templated message with --no-llm (no oneShot given)', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    const commit = await commitBrain(brainPath, { author: 'alice' });
    expect(commit?.message).toBe('add 1 node(s)');
  });
});

describe('createBranch / checkoutBrain', () => {
  it('branches off HEAD and checkout switches brain.json to that branch state', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    await commitBrain(brainPath, { author: 'alice', message: 'base' });

    createBranch(brainPath, 'feature');
    checkoutBrain(brainPath, 'feature');
    expect(loadRefs(brainPath).HEAD).toBe('feature');

    const brain = loadBrain(brainPath)!;
    upsertNode(brain, node('feature-node'));
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'feature work' });

    checkoutBrain(brainPath, 'main');
    expect(loadRefs(brainPath).HEAD).toBe('main');
    expect(loadBrain(brainPath)!.nodes.map((n) => n.id)).toEqual(['a']);

    checkoutBrain(brainPath, 'feature');
    expect(loadBrain(brainPath)!.nodes.map((n) => n.id).sort()).toEqual(['a', 'feature-node']);
  });

  it('checking out a bare commit id mints a detached branch', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    const commit = await commitBrain(brainPath, { author: 'alice' });
    checkoutBrain(brainPath, commit!.id);
    expect(loadRefs(brainPath).HEAD).toBe(`detached-${commit!.id}`);
  });

  it('throws for an unknown branch/commit', () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [], edges: [] });
    expect(() => checkoutBrain(brainPath, 'nope')).toThrow();
  });
});

describe('mergeBranch', () => {
  async function baseWithTwoBranches() {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    await commitBrain(brainPath, { author: 'alice', message: 'base' });
    createBranch(brainPath, 'feature');
  }

  it('unions disjoint additions from two branches with no conflicts', async () => {
    await baseWithTwoBranches();

    checkoutBrain(brainPath, 'feature');
    let brain = loadBrain(brainPath)!;
    upsertNode(brain, node('from-feature'));
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'feature work' });

    checkoutBrain(brainPath, 'main');
    brain = loadBrain(brainPath)!;
    upsertNode(brain, node('from-main'));
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'main work' });

    const outcome = await mergeBranch(brainPath, 'feature', { author: 'alice' });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.commit?.parents).toHaveLength(2);
    expect(loadBrain(brainPath)!.nodes.map((n) => n.id).sort()).toEqual(['a', 'from-feature', 'from-main']);
  });

  it('keeps "ours" for a true conflict without --llm, and reports it', async () => {
    await baseWithTwoBranches();

    checkoutBrain(brainPath, 'feature');
    let brain = loadBrain(brainPath)!;
    brain.nodes.find((n) => n.id === 'a')!.title = 'theirs-title';
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'edit a on feature' });

    checkoutBrain(brainPath, 'main');
    brain = loadBrain(brainPath)!;
    brain.nodes.find((n) => n.id === 'a')!.title = 'ours-title';
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'edit a on main' });

    const outcome = await mergeBranch(brainPath, 'feature', { author: 'alice' });
    expect(outcome.conflicts).toHaveLength(1);
    expect(loadBrain(brainPath)!.nodes.find((n) => n.id === 'a')?.title).toBe('ours-title');
  });

  it('resolves a conflict via the given oneShot when provided', async () => {
    await baseWithTwoBranches();

    checkoutBrain(brainPath, 'feature');
    let brain = loadBrain(brainPath)!;
    brain.nodes.find((n) => n.id === 'a')!.title = 'theirs-title';
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'edit a on feature' });

    checkoutBrain(brainPath, 'main');
    brain = loadBrain(brainPath)!;
    brain.nodes.find((n) => n.id === 'a')!.title = 'ours-title';
    saveBrain(brainPath, brain);
    await commitBrain(brainPath, { author: 'alice', message: 'edit a on main' });

    const oneShot = async () => JSON.stringify({ title: 'merged-title', content: 'merged content' });
    const outcome = await mergeBranch(brainPath, 'feature', { author: 'alice', oneShot });
    expect(outcome.conflicts).toHaveLength(1);
    expect(loadBrain(brainPath)!.nodes.find((n) => n.id === 'a')?.title).toBe('merged-title');
  });

  it('throws merging an unknown branch', async () => {
    await baseWithTwoBranches();
    await expect(mergeBranch(brainPath, 'nope', { author: 'alice' })).rejects.toThrow();
  });
});
