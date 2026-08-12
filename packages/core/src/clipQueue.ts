// The clip queue's fs half: an append-only .nff-brain/clips.jsonl beside a brain
// file. The Chrome extension POSTs captures to `nff-brain serve`, which appends
// here; the SessionEnd distiller later drains the queue and mints nodes.
//
// This mirrors activityStore.ts closely, with TWO DELIBERATE DIVERGENCES:
//
//  1. IT TAKES THE LOCK. activityStore is lock-free because sub-4KB O_APPEND
//     writes are atomically positioned on both POSIX and NTFS. That argument
//     fails here for two independent reasons: a clip line can exceed PIPE_BUF,
//     and — the real one — draining CONSUMES, which is read-then-remove and can
//     never be made safe by offset-based tailing.
//
//  2. AT THE SIZE CAP IT REFUSES INSTEAD OF ROTATING. An activity event is
//     advisory telemetry where a lost line costs a missed animation. A clip is
//     user intent that has not landed in the brain yet, so silently discarding
//     it is the worst failure available. 2 MB is roughly 500 full-size clips —
//     reaching it means months without a session.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_CLIP_LINE_BYTES, newClipId, normalizeClip, parseClipLines } from './clip.js';
import type { ClipInput, ClipRecord, ClipTarget } from './clip.js';
import { brainLogPath } from './paths.js';
import { acquireLock } from './store.js';

export const CLIPS_FILE = 'clips.jsonl';
export const CLIPS_PROCESSING_FILE = 'clips.processing.jsonl';
export const MAX_CLIPS_BYTES = 2 * 1024 * 1024;

export function clipsPath(brainPath: string): string {
  return brainLogPath(brainPath, CLIPS_FILE);
}

export function clipsProcessingPath(brainPath: string): string {
  return brainLogPath(brainPath, CLIPS_PROCESSING_FILE);
}

export type AppendClipResult =
  | { ok: true; id: string; pending: number }
  | { ok: false; reason: 'invalid' | 'too_large' | 'queue_full' };

export interface AppendClipContext {
  target: ClipTarget;
  source: string;
  workspaceRoot?: string;
  clientId?: string;
  now?: Date;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function countLines(file: string): number {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

/**
 * Append one clip. Unlike appendActivity this REPORTS failure rather than
 * swallowing it — the caller is an HTTP handler that owes the user a status
 * code, and a dropped clip is a dropped intention.
 */
export function appendClip(brainPath: string, input: ClipInput, ctx: AppendClipContext): AppendClipResult {
  const now = ctx.now ?? new Date();
  const record = normalizeClip(input, {
    id: newClipId(now.getTime(), randomBytes(3).toString('hex')),
    at: now.toISOString(),
    target: ctx.target,
    source: ctx.source,
    workspaceRoot: ctx.workspaceRoot,
    clientId: ctx.clientId,
  });
  if (!record) return { ok: false, reason: 'invalid' };

  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_CLIP_LINE_BYTES) return { ok: false, reason: 'too_large' };

  const file = clipsPath(brainPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(file);
  try {
    if (fileSize(file) + Buffer.byteLength(line, 'utf8') > MAX_CLIPS_BYTES) {
      return { ok: false, reason: 'queue_full' };
    }
    fs.appendFileSync(file, line);
    return { ok: true, id: record.id, pending: countLines(file) };
  } finally {
    release();
  }
}

export interface ClipQueueStats {
  pending: number;
  bytes: number;
  full: boolean;
}

/** Cheap enough for /v1/status and doctor — one stat plus one small read. */
export function clipQueueStats(brainPath: string): ClipQueueStats {
  const file = clipsPath(brainPath);
  const bytes = fileSize(file);
  return {
    pending: countLines(file) + countLines(clipsProcessingPath(brainPath)),
    bytes,
    full: bytes >= MAX_CLIPS_BYTES,
  };
}

/** Non-destructive read, for status output and `nff-brain clips`. */
export function readClips(brainPath: string, limit?: number): ClipRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(clipsPath(brainPath), 'utf8');
  } catch {
    return [];
  }
  const all = parseClipLines(raw);
  return limit === undefined ? all : all.slice(0, limit);
}

/**
 * Claim the queue for draining. Phase one of two, so the lock is never held
 * across an LLM call.
 *
 * The live file is renamed aside (atomic — new appends immediately recreate a
 * fresh clips.jsonl), and any leftover .processing file from a drain that died
 * mid-flight is folded back in first. That makes delivery AT LEAST ONCE, which
 * the distiller's id-keyed upsert absorbs. Losing clips is not on the table.
 */
export function takeClips(brainPath: string): { records: ClipRecord[]; handle: string | null } {
  const live = clipsPath(brainPath);
  const processing = clipsProcessingPath(brainPath);
  const release = acquireLock(live);
  try {
    const hasLive = fs.existsSync(live);
    const hasPrior = fs.existsSync(processing);
    if (!hasLive && !hasPrior) return { records: [], handle: null };

    if (hasLive) {
      if (hasPrior) {
        // A previous drain never finished. Fold rather than clobber.
        fs.appendFileSync(processing, fs.readFileSync(live));
        fs.rmSync(live, { force: true });
      } else {
        fs.renameSync(live, processing);
      }
    }
    return { records: parseClipLines(fs.readFileSync(processing, 'utf8')), handle: processing };
  } finally {
    release();
  }
}

/** Phase two: the drain succeeded, so the claimed batch can go. */
export function finishTake(handle: string): void {
  try {
    fs.rmSync(handle, { force: true });
  } catch {
    /* the next takeClips folds it back in — at-least-once by design */
  }
}
