// Push a branch's local commits to the shared company brain (nff-admin
// migration 0140's brain_commits/brain_branches table), incrementally: only
// commits made since the last successful push for this branch (refs.json's
// `lastPushed`, so a first push sends the whole branch and every push after
// sends just what's new). Mirrors the VS Code extension's existing company-
// sync contract (the `x-brain-sync-token` header) but posts commits, not a
// wholesale node list — see api/_lib/brain.ts's handleBrainCommitsPush.

import { commitChain, type Commit } from './versioning.js';
import { commitsById, loadCommits, loadRefs, saveRefs } from './versionStore.js';

export interface PushOptions {
  token: string;
  url?: string;
  branch?: string; // defaults to refs.HEAD
}

export interface PushResult {
  pushed: number;
  merged: boolean;
}

export const DEFAULT_PUSH_URL = 'https://admin.nanoforgeflow.com/api/tables/brain/commits/push';

/** Commits on the chain ending at `headId`, after `sinceId` (exclusive). Absent `sinceId` = the whole chain. */
function commitsSince(byId: Map<string, Commit>, headId: string, sinceId?: string): Commit[] {
  const chain = commitChain(byId, headId);
  if (!sinceId) return chain;
  const i = chain.findIndex((c) => c.id === sinceId);
  return i === -1 ? chain : chain.slice(i + 1);
}

export async function pushBranch(brainPath: string, opts: PushOptions): Promise<PushResult> {
  const refs = loadRefs(brainPath);
  const branch = opts.branch ?? refs.HEAD;
  const headId = refs.branches[branch];
  if (!headId) throw new Error(`branch "${branch}" has no commits`);

  const byId = commitsById(loadCommits(brainPath));
  const pending = commitsSince(byId, headId, refs.lastPushed?.[branch]);
  if (pending.length === 0) return { pushed: 0, merged: false };

  const url = opts.url ?? DEFAULT_PUSH_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-brain-sync-token': opts.token },
    body: JSON.stringify({ commits: pending }),
  });
  if (!res.ok) throw new Error(`push failed: HTTP ${res.status}`);
  const body = (await res.json()) as PushResult;

  refs.lastPushed = { ...refs.lastPushed, [branch]: headId };
  saveRefs(brainPath, refs);
  return body;
}
