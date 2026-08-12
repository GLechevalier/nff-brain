// The shared scan/extract/reconcile/write machinery behind `nff-brain
// import`, used by both the classic flag path and the wizard. NEVER prints —
// progress is a callback, results are return values.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PENDING_FILE,
  PREVIEW_FILE,
  ageDaysOf,
  brainLogPath,
  buildImportPrompt,
  clusterProposals,
  discoverSessions,
  hasCorrection,
  mapPool,
  parseImportResponse,
  readTranscriptWindow,
  reconcileWithBrain,
  renderImportPreview,
  runClaude,
  saveImportState,
  seenProposalHashes,
  skippableSessionIds,
  type BrainFile,
  type DiscoverResult,
  type ImportState,
  type PendingFile,
  type PendingItem,
  type PoolResult,
  type Proposal,
  type SessionMeta,
} from '@nff-brain/core';
import type { ImportPlan } from './importPlan.js';

export const MAX_PER_KIND = 4;
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const MIN_TRANSCRIPT_CHARS = 2_000; // import's bar is far above distill's 200
// Import windows are a full 12 KB, unlike distill's tail-capped ones, so they
// get longer than runClaude's 60 s default — but an explicit env override still
// wins, which is what lets the e2e suite exercise the hang path quickly.
const IMPORT_TIMEOUT_MS = 90_000;
export function importTimeoutMs(): number {
  return Number(process.env.NFF_BRAIN_TIMEOUT_MS) || IMPORT_TIMEOUT_MS;
}

export function label(s: SessionMeta): string {
  return s.title ?? s.firstPrompt.slice(0, 48) ?? s.sessionId.slice(0, 8);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function discoverForPlan(plan: ImportPlan, state: ImportState): DiscoverResult {
  return discoverSessions({
    cwd: plan.paths.workspaceRoot,
    project: plan.project,
    all: plan.all,
    limit: plan.limit,
    sinceMs: plan.sinceMs,
    skipSessionIds: plan.force ? undefined : skippableSessionIds(state),
    dirCwdCache: state.dirCwd,
  });
}

export interface ExtractResult {
  proposals: Proposal[];
  failures: number;
}

export async function extractProposals(
  sessions: readonly SessionMeta[],
  plan: ImportPlan,
  knownNodes: BrainFile['nodes'],
  onSettle?: (done: number, total: number, r: PoolResult<SessionMeta, Proposal[]>) => void,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  let failures = 0;
  const results = await mapPool(
    sessions as SessionMeta[],
    plan.concurrency,
    async (session): Promise<Proposal[]> => {
      // Drain fast on abort: queued sessions return before any I/O so
      // mapPool's un-cancellable Promise.all resolves promptly.
      if (signal?.aborted) return [];
      const transcript = readTranscriptWindow(session.file);
      if (transcript.length < MIN_TRANSCRIPT_CHARS) return [];
      const prompt = buildImportPrompt({
        taskText: session.firstPrompt || label(session),
        transcript,
        knownNodes,
        maxPerKind: MAX_PER_KIND,
        maxTranscriptChars: MAX_TRANSCRIPT_CHARS,
        sessionLabel: label(session),
      });
      const raw = await runClaude(prompt, { model: plan.model, timeoutMs: importTimeoutMs(), signal });
      return parseImportResponse(raw, {
        session: { sessionId: session.sessionId, title: session.title, date: session.endedAt },
        transcriptChars: transcript.length,
        hasCorrection: hasCorrection(transcript),
        ageDays: ageDaysOf(session.endedAt),
        maxPerKind: MAX_PER_KIND,
      });
    },
    (done, total, r) => {
      if (r.error) failures += 1;
      onSettle?.(done, total, r);
    },
  );
  return { proposals: results.flatMap((r) => r.value ?? []), failures };
}

export function reconcileProposals(
  proposals: Proposal[],
  plan: ImportPlan,
  brain: BrainFile | null,
  state: ImportState,
): PendingItem[] {
  const clusters = clusterProposals(proposals);
  return reconcileWithBrain(brain ?? { version: 1, updatedAt: '', nodes: [], edges: [] }, clusters, {
    minConfidence: plan.minConfidence,
    seenHashes: plan.force ? undefined : seenProposalHashes(state),
  });
}

export interface PreviewArtifacts {
  pending: PendingFile;
  previewPath: string;
  pendingPath: string;
  createdAt: string;
}

export function writePreviewArtifacts(
  items: readonly PendingItem[],
  plan: ImportPlan,
  found: Pick<DiscoverResult, 'sessions'>,
  brain: BrainFile | null,
  state: ImportState,
): PreviewArtifacts {
  const createdAt = new Date().toISOString();
  const pending: PendingFile = {
    version: 1,
    createdAt,
    workspaceRoot: plan.paths.workspaceRoot,
    brainPath: plan.target,
    brainUpdatedAt: brain?.updatedAt ?? '',
    minConfidence: plan.minConfidence,
    sessionsRead: found.sessions.map((s) => s.sessionId),
    sessionBytes: Object.fromEntries(found.sessions.map((s) => [s.sessionId, s.bytes])),
    items: [...items],
  };

  const previewPath = brainLogPath(plan.target, PREVIEW_FILE);
  const pendingPath = brainLogPath(plan.target, PENDING_FILE);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(
    previewPath,
    renderImportPreview(items, {
      brainPath: plan.target,
      sessionCount: found.sessions.length,
      createdAt,
      minConfidence: plan.minConfidence,
    }),
    'utf8',
  );
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');

  // Discovery cache only — the sessions are NOT marked imported until --apply,
  // so an abandoned preview leaves the next run free to re-read them.
  state.dirCwd = { ...state.dirCwd };
  saveImportState(plan.target, state);

  return { pending, previewPath, pendingPath, createdAt };
}

export type EmptyReason =
  | { kind: 'already-imported'; count: number }
  | { kind: 'oneshot-only'; count: number }
  | { kind: 'no-history'; projectsDir: string }
  | { kind: 'cleared-history'; workspaceRoot: string; prompts: number }
  | { kind: 'never-worked-here'; workspaceRoot: string };

/**
 * Order matters: a folder routinely has BOTH already-mined sessions and
 * one-shots, and "no new sessions" is the more useful of the two answers.
 */
export function classifyEmptyScan(
  found: DiscoverResult,
  workspaceRoot: string,
  promptCount: number,
): EmptyReason {
  if (found.skipped.alreadyImported) return { kind: 'already-imported', count: found.skipped.alreadyImported };
  if (found.skipped.oneshot) return { kind: 'oneshot-only', count: found.skipped.oneshot };
  if (found.scanned.dirs === 0) return { kind: 'no-history', projectsDir: found.projectsDir };
  if (promptCount > 0) return { kind: 'cleared-history', workspaceRoot, prompts: promptCount };
  return { kind: 'never-worked-here', workspaceRoot };
}

/** Exact strings of the classic empty-scan report — tested for zero drift. */
export function emptyScanLines(r: EmptyReason): string[] {
  switch (r.kind) {
    case 'already-imported':
      return [`no new sessions since the last import (${r.count} already mined).`, 'use --force to re-scan them.'];
    case 'oneshot-only':
      // The nff-brain repo itself hits this: its project folder holds only the
      // `claude -p` calls nff-brain made, never a human session.
      return [`the only transcripts for this folder are ${r.count} one-shot \`claude -p\` run(s) — nothing to import.`];
    case 'no-history':
      return [`no Claude Code history at ${r.projectsDir}`, 'set NFF_BRAIN_CLAUDE_HOME if your config lives elsewhere.'];
    case 'cleared-history':
      return [
        `no transcripts for ${r.workspaceRoot}, though history.jsonl remembers ${r.prompts} prompt(s) here —`,
        'your transcripts may have been cleared.',
      ];
    case 'never-worked-here':
      return [`no past sessions found for ${r.workspaceRoot}.`, 'try --all to sweep every project, or --project <path>.'];
  }
}
