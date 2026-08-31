import { describe, expect, it } from 'vitest';
import {
  applyDiff,
  commitChain,
  commitsById,
  diffBrainState,
  emptyBrain,
  findMergeBase,
  isEmptyDiff,
  replayCommits,
  templateCommitMessage,
  threeWayMerge,
  type BrainFile,
  type BrainNode,
  type Commit,
} from '../src/index.js';

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
    lastUpdated: '2026-01-01T00:00:00.000Z',
    recallCount: 0,
    ...extra,
  };
}

function commit(id: string, parents: string[], diff: ReturnType<typeof diffBrainState>): Commit {
  return { id, parents, branch: 'main', author: 'a', ts: '2026-01-01T00:00:00.000Z', message: 'm', diff };
}

describe('diffBrainState / applyDiff', () => {
  it('detects additions, removals and modifications', () => {
    const before: BrainFile = { ...emptyBrain(), nodes: [node('a'), node('b')] };
    const after: BrainFile = {
      ...emptyBrain(),
      nodes: [node('a', { title: 'A changed' }), node('c')],
    };
    const diff = diffBrainState(before, after);
    expect(diff.nodesAdded.map((n) => n.id)).toEqual(['c']);
    expect(diff.nodesRemoved).toEqual(['b']);
    expect(diff.nodesModified.map((m) => m.id)).toEqual(['a']);
  });

  it('round-trips: applyDiff(before, diffBrainState(before, after)) === after', () => {
    const before: BrainFile = { ...emptyBrain(), nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', strength: 0.5 }] };
    const after: BrainFile = { ...emptyBrain(), nodes: [node('a'), node('c')], edges: [{ from: 'a', to: 'c', strength: 0.8 }] };
    const diff = diffBrainState(before, after);
    const result = applyDiff(before, diff);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(after.nodes.map((n) => n.id).sort());
    expect(result.edges).toEqual(after.edges);
  });

  it('isEmptyDiff is true only when nothing changed', () => {
    const a: BrainFile = { ...emptyBrain(), nodes: [node('a')] };
    expect(isEmptyDiff(diffBrainState(a, a))).toBe(true);
    expect(isEmptyDiff(diffBrainState(a, { ...emptyBrain(), nodes: [node('a'), node('b')] }))).toBe(false);
  });

  it('edges are unordered — from/to swap is not a change', () => {
    const before: BrainFile = { ...emptyBrain(), nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', strength: 0.5 }] };
    const after: BrainFile = { ...emptyBrain(), nodes: [node('a'), node('b')], edges: [{ from: 'b', to: 'a', strength: 0.5 }] };
    expect(isEmptyDiff(diffBrainState(before, after))).toBe(true);
  });
});

describe('commit chain / replay / merge base', () => {
  it('replays a chain of commits from empty back to the target state', () => {
    const empty = emptyBrain();
    const s1: BrainFile = { ...empty, nodes: [node('a')] };
    const s2: BrainFile = { ...empty, nodes: [node('a'), node('b')] };
    const c1 = commit('c1', [], diffBrainState(empty, s1));
    const c2 = commit('c2', ['c1'], diffBrainState(s1, s2));
    const byId = commitsById([c1, c2]);
    expect(replayCommits(commitChain(byId, 'c2'), empty).nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(replayCommits(commitChain(byId, 'c1'), empty).nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('findMergeBase finds the common ancestor of two diverged branches', () => {
    const empty = emptyBrain();
    const root = commit('root', [], diffBrainState(empty, { ...empty, nodes: [node('a')] }));
    const left = commit('left', ['root'], diffBrainState(empty, { ...empty, nodes: [node('b')] }));
    const right = commit('right', ['root'], diffBrainState(empty, { ...empty, nodes: [node('c')] }));
    const byId = commitsById([root, left, right]);
    expect(findMergeBase(byId, 'left', 'right')).toBe('root');
    expect(findMergeBase(byId, 'left', 'left')).toBe('left');
  });

  it('findMergeBase returns null for unrelated histories', () => {
    const empty = emptyBrain();
    const a = commit('a', [], diffBrainState(empty, empty));
    const b = commit('b', [], diffBrainState(empty, empty));
    expect(findMergeBase(commitsById([a, b]), 'a', 'b')).toBeNull();
  });
});

describe('threeWayMerge', () => {
  const empty = emptyBrain();

  it('unions non-overlapping additions from both sides with no conflicts', () => {
    const ours: BrainFile = { ...empty, nodes: [node('a'), node('ours-new')] };
    const theirs: BrainFile = { ...empty, nodes: [node('a'), node('theirs-new')] };
    const result = threeWayMerge({ ...empty, nodes: [node('a')] }, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.nodes.map((n) => n.id).sort()).toEqual(['a', 'ours-new', 'theirs-new']);
  });

  it('flags a true conflict when both sides edit the same node differently', () => {
    const base: BrainFile = { ...empty, nodes: [node('a')] };
    const ours: BrainFile = { ...empty, nodes: [node('a', { title: 'ours' })] };
    const theirs: BrainFile = { ...empty, nodes: [node('a', { title: 'theirs' })] };
    const result = threeWayMerge(base, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].id).toBe('a');
  });

  it('takes the non-base side automatically when only one side changed it', () => {
    const base: BrainFile = { ...empty, nodes: [node('a')] };
    const ours: BrainFile = { ...empty, nodes: [node('a')] }; // unchanged
    const theirs: BrainFile = { ...empty, nodes: [node('a', { title: 'theirs' })] };
    const result = threeWayMerge(base, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.nodes.find((n) => n.id === 'a')?.title).toBe('theirs');
  });

  it('a deletion on one side wins when the other side left it untouched', () => {
    const base: BrainFile = { ...empty, nodes: [node('a')] };
    const ours: BrainFile = { ...empty, nodes: [] }; // deleted
    const theirs: BrainFile = { ...empty, nodes: [node('a')] }; // untouched
    const result = threeWayMerge(base, ours, theirs);
    expect(result.merged.nodes).toEqual([]);
  });
});

describe('templateCommitMessage', () => {
  it('summarizes counts by kind', () => {
    const diff = diffBrainState(
      { ...emptyBrain(), nodes: [node('a'), node('b')] },
      { ...emptyBrain(), nodes: [node('a', { title: 'changed' }), node('c')] },
    );
    expect(templateCommitMessage(diff)).toBe('add 1 node(s), update 1 node(s), remove 1 node(s)');
  });

  it('falls back to "no changes" for an empty diff', () => {
    const b = { ...emptyBrain(), nodes: [node('a')] };
    expect(templateCommitMessage(diffBrainState(b, b))).toBe('no changes');
  });
});
