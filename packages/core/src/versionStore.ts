// Versioning's fs half: refs.json (branch pointers + HEAD) and the append-only
// commits.jsonl beside brain.json — same durability pattern as activityStore.ts
// (mkdir + atomic write for refs, plain appendFileSync for the log) plus
// store.ts's lock for the brain.json read-modify-write a commit/checkout/merge
// does. High-level git-like ops (commit/branch/checkout/merge) live here too,
// since they all need this same fs plumbing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { commitsPath, refsPath } from './paths.js';
import { acquireLock, loadBrain, saveBrain, writeFileAtomic } from './store.js';
import { emptyBrain, type BrainFile, type BrainNode } from './types.js';
import {
  MAIN_BRANCH,
  applyResolutions,
  diffBrainState,
  emptyRefs,
  findMergeBase,
  isEmptyDiff,
  materialize,
  resolveConflictWithLLM,
  synthesizeCommitMessage,
  templateCommitMessage,
  threeWayMerge,
  type Commit,
  type MergeConflict,
  type Refs,
} from './versioning.js';
import type { OneShot } from './claude.js';

export function newCommitId(nowMs = Date.now(), suffix = randomBytes(3).toString('hex')): string {
  return `cmt_${nowMs}_${suffix}`;
}

export function loadRefs(brainPath: string): Refs {
  try {
    const raw = fs.readFileSync(refsPath(brainPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Refs>;
    return {
      branches: parsed.branches && typeof parsed.branches === 'object' ? parsed.branches : {},
      HEAD: typeof parsed.HEAD === 'string' && parsed.HEAD ? parsed.HEAD : MAIN_BRANCH,
      ...(parsed.lastPushed ? { lastPushed: parsed.lastPushed } : {}),
    };
  } catch {
    return emptyRefs();
  }
}

export function saveRefs(brainPath: string, refs: Refs): void {
  writeFileAtomic(refsPath(brainPath), JSON.stringify(refs, null, 2) + '\n');
}

function isCommit(v: unknown): v is Commit {
  const c = v as Partial<Commit> | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    Array.isArray(c.parents) &&
    typeof c.branch === 'string' &&
    typeof c.ts === 'string' &&
    typeof c.message === 'string' &&
    !!c.diff &&
    typeof c.diff === 'object'
  );
}

/** Full parse — commit counts stay small (brains are capped at a few thousand nodes), unlike activity.jsonl there's no tail-only reader. */
export function loadCommits(brainPath: string): Commit[] {
  let raw: string;
  try {
    raw = fs.readFileSync(commitsPath(brainPath), 'utf8');
  } catch {
    return [];
  }
  const commits: Commit[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isCommit(parsed)) commits.push(parsed);
    } catch {
      /* torn tail from a crashed writer — skip */
    }
  }
  return commits;
}

export function commitsById(commits: Commit[]): Map<string, Commit> {
  return new Map(commits.map((c) => [c.id, c]));
}

function appendCommit(brainPath: string, commit: Commit): void {
  const file = commitsPath(brainPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(commit) + '\n');
}

// ── high-level ops ────────────────────────────────────────────────────────────

export interface CommitOptions {
  author: string;
  message?: string;
  oneShot?: OneShot;
  branch?: string; // defaults to refs.HEAD
}

/** Diff HEAD's last committed state against the current brain.json and commit it. Null when nothing changed. */
export async function commitBrain(brainPath: string, opts: CommitOptions): Promise<Commit | null> {
  const refs = loadRefs(brainPath);
  const branch = opts.branch ?? refs.HEAD;
  const commits = loadCommits(brainPath);
  const byId = commitsById(commits);
  const headId = refs.branches[branch];

  const before = headId ? materialize(byId, headId, emptyBrain()) : emptyBrain();
  const after = loadBrain(brainPath) ?? emptyBrain();
  const diff = diffBrainState(before, after);
  if (isEmptyDiff(diff)) return null;

  const message = opts.message ?? (opts.oneShot ? await synthesizeCommitMessage(opts.oneShot, diff) : templateCommitMessage(diff));
  const commit: Commit = {
    id: newCommitId(),
    parents: headId ? [headId] : [],
    branch,
    author: opts.author,
    ts: new Date().toISOString(),
    message,
    diff,
  };
  appendCommit(brainPath, commit);
  refs.branches[branch] = commit.id;
  refs.HEAD = branch;
  saveRefs(brainPath, refs);
  return commit;
}

/** Create a branch pointer. Defaults to HEAD's current tip; throws if it already exists or has no history. */
export function createBranch(brainPath: string, name: string, from?: string): Refs {
  const refs = loadRefs(brainPath);
  if (refs.branches[name]) throw new Error(`branch "${name}" already exists`);
  const commits = loadCommits(brainPath);
  const byId = commitsById(commits);
  const source = from ?? refs.HEAD;
  const fromId = refs.branches[source] ?? (byId.has(source) ? source : undefined);
  if (!fromId) throw new Error(`no commits yet on "${source}" — commit something first`);
  refs.branches[name] = fromId;
  saveRefs(brainPath, refs);
  return refs;
}

/**
 * Switch brain.json to another branch or commit's materialized state.
 * ponytail: no real detached HEAD — checking out a bare commit id mints a
 * `detached-<id>` branch pointing at it, so every checkout still lands on a
 * named branch and the next commit always has somewhere to advance.
 */
export function checkoutBrain(brainPath: string, target: string): { refs: Refs; state: BrainFile } {
  const refs = loadRefs(brainPath);
  const commits = loadCommits(brainPath);
  const byId = commitsById(commits);

  let branch: string;
  let commitId: string;
  if (refs.branches[target]) {
    branch = target;
    commitId = refs.branches[target];
  } else if (byId.has(target)) {
    branch = `detached-${target}`;
    commitId = target;
    refs.branches[branch] = commitId;
  } else {
    throw new Error(`no branch or commit "${target}"`);
  }

  const state = materialize(byId, commitId, emptyBrain());
  const release = acquireLock(brainPath);
  try {
    saveBrain(brainPath, state);
  } finally {
    release();
  }
  refs.HEAD = branch;
  saveRefs(brainPath, refs);
  return { refs, state };
}

export interface MergeOptions {
  author: string;
  oneShot?: OneShot;
  targetBranch?: string; // defaults to refs.HEAD
}

export interface MergeOutcome {
  commit: Commit | null; // null when there was nothing to merge
  conflicts: MergeConflict[]; // resolved via LLM when oneShot was given, else left as "ours"
}

/** Three-way merge `sourceBranch` into `targetBranch` (default HEAD), writing a merge commit. */
export async function mergeBranch(
  brainPath: string,
  sourceBranch: string,
  opts: MergeOptions,
): Promise<MergeOutcome> {
  const refs = loadRefs(brainPath);
  const targetBranch = opts.targetBranch ?? refs.HEAD;
  const oursId = refs.branches[targetBranch];
  const theirsId = refs.branches[sourceBranch];
  if (!oursId) throw new Error(`branch "${targetBranch}" has no commits`);
  if (!theirsId) throw new Error(`no branch "${sourceBranch}"`);
  if (oursId === theirsId) return { commit: null, conflicts: [] };

  const commits = loadCommits(brainPath);
  const byId = commitsById(commits);
  const baseId = findMergeBase(byId, oursId, theirsId);
  const empty = emptyBrain();
  const baseState = baseId ? materialize(byId, baseId, empty) : empty;
  const oursState = materialize(byId, oursId, empty);
  const theirsState = materialize(byId, theirsId, empty);

  const result = threeWayMerge(baseState, oursState, theirsState);
  let merged = result.merged;
  if (result.conflicts.length && opts.oneShot) {
    const resolved = new Map<string, BrainNode>();
    for (const conflict of result.conflicts) {
      resolved.set(conflict.id, await resolveConflictWithLLM(opts.oneShot, conflict));
    }
    merged = applyResolutions(result, resolved);
  }

  const diff = diffBrainState(oursState, merged);
  const commit: Commit = {
    id: newCommitId(),
    parents: [oursId, theirsId],
    branch: targetBranch,
    author: opts.author,
    ts: new Date().toISOString(),
    message: `Merge ${sourceBranch} into ${targetBranch}`,
    diff,
  };
  appendCommit(brainPath, commit);
  refs.branches[targetBranch] = commit.id;
  refs.HEAD = targetBranch;
  saveRefs(brainPath, refs);

  const release = acquireLock(brainPath);
  try {
    saveBrain(brainPath, merged);
  } finally {
    release();
  }

  return { commit, conflicts: result.conflicts };
}
