// The activity stream's fs half: an append-only .nff-brain/activity.jsonl
// beside the project brain.json. CLI commands append one line per "the agent
// looked at these nodes" moment; the VS Code extension tail-reads new lines
// and animates them. Like model-request.json this is advisory telemetry —
// every writer is fail-open and a lost line costs nothing but a missed pulse.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseActivityLines, type ActivityEvent } from './activity.js';
import { brainLogPath } from './paths.js';

export const ACTIVITY_FILE = 'activity.jsonl';
const MAX_IDS_PER_EVENT = 100;
const ROTATE_BYTES = 256 * 1024;
const TRUNCATE_BYTES = 2 * 1024 * 1024; // backstop when rotation keeps failing
const REPLAY_TAIL_BYTES = 64 * 1024;

/** Beside the brain file, like the fail-open logs. */
export function activityPath(brainPath: string): string {
  return brainLogPath(brainPath, ACTIVITY_FILE);
}

/**
 * Append one event. Never throws and never touches stdout — recall/novelty
 * stdout is injected into the Claude session.
 *
 * Concurrency stance: no lock. The single appendFileSync opens with O_APPEND,
 * and small (<4KB) single-write appends are atomically positioned on both
 * POSIX and NTFS, so two racing CLI processes can interleave LINES but not
 * bytes within a line. The worst case (a torn tail from a crash mid-write) is
 * skipped by parseActivityLines.
 */
export function appendActivity(
  brainPath: string,
  event: Omit<ActivityEvent, 'v' | 'at'> & { at?: string },
): void {
  try {
    const file = activityPath(brainPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const full: ActivityEvent = {
      v: 1,
      at: event.at ?? new Date().toISOString(),
      kind: event.kind,
      ids: event.ids.slice(0, MAX_IDS_PER_EVENT),
      ...(event.seedCount !== undefined ? { seedCount: Math.min(event.seedCount, MAX_IDS_PER_EVENT) } : {}),
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(full) + '\n');
  } catch {
    /* fail-open: animation telemetry must never break a hook */
  }
}

// Rotation renames the live file away instead of rewriting its tail — a
// tail-keeping truncate would replay old events at new offsets in every
// watching extension. Readers detect the shrink (size < offset) and reset.
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size <= ROTATE_BYTES) return;
  try {
    fs.rmSync(`${file}.old`, { force: true });
    fs.renameSync(file, `${file}.old`);
  } catch {
    // Windows can EPERM the rename while a reader holds a transient handle —
    // skip and retry on the next event. If it keeps failing, truncate rather
    // than grow forever; the readers' shrink detection absorbs it.
    if (size > TRUNCATE_BYTES) {
      try {
        fs.writeFileSync(file, '');
      } catch {
        /* give up until next event */
      }
    }
  }
}

/**
 * Read events appended since `offset` (a byte position). Returns the next
 * offset to resume from — advanced only to the end of the last complete
 * newline-terminated line, so a partial tail is picked up by the next call.
 * A shrunken file (rotation/truncation) resets to 0; the fresh file contains
 * only post-rotation events, so no duplicates are produced.
 */
export function readNewActivity(
  file: string,
  offset: number,
): { events: ActivityEvent[]; nextOffset: number } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { events: [], nextOffset: 0 };
  }
  let from = offset;
  if (size < from) from = 0;
  if (size === from) return { events: [], nextOffset: from };

  let chunk: string;
  try {
    // Open/read/close — no persistent handle, so the writer's rotation rename
    // stays viable on Windows.
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      const read = fs.readSync(fd, buf, 0, buf.length, from);
      chunk = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], nextOffset: from };
  }

  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { events: [], nextOffset: from }; // partial tail only
  const complete = chunk.slice(0, lastNewline + 1);
  return {
    events: parseActivityLines(complete),
    nextOffset: from + Buffer.byteLength(complete, 'utf8'),
  };
}

/** Tail read for panel-open replay: events at most `sinceMs` old. */
export function readRecentActivity(file: string, sinceMs: number): ActivityEvent[] {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return [];
  }
  const from = Math.max(0, size - REPLAY_TAIL_BYTES);
  let chunk: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      const read = fs.readSync(fd, buf, 0, buf.length, from);
      chunk = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  // A mid-file start almost certainly lands inside a line — drop up to the
  // first newline (harmless when from === 0 and the first line is complete
  // anyway, since we only lose events old enough to have rotated past).
  if (from > 0) {
    const nl = chunk.indexOf('\n');
    chunk = nl === -1 ? '' : chunk.slice(nl + 1);
  }
  const cutoff = Date.now() - sinceMs;
  return parseActivityLines(chunk).filter((e) => Date.parse(e.at) >= cutoff);
}
