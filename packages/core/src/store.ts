import * as fs from 'node:fs';
import * as path from 'node:path';
import { BRAIN_VERSION, emptyBrain, type BrainEdge, type BrainFile, type BrainNode } from './types.js';

// Local JSON persistence with the two properties the hook/extension concurrency
// story needs: ATOMIC writes (temp + rename, with a Windows EPERM retry loop —
// Defender/indexers briefly hold files) and a cross-platform LOCK directory
// (mkdir is atomic everywhere; O_EXCL misbehaves on some network drives).

const LOCK_STALE_MS = 10_000;
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 50;

export class BrainVersionError extends Error {
  constructor(public filePath: string, public found: number) {
    super(
      `${filePath} has schema version ${found}, newer than this tool understands (${BRAIN_VERSION}). ` +
        `Upgrade nff-brain (npm i -g nff-brain).`,
    );
    this.name = 'BrainVersionError';
  }
}

function sleep(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/** Load a brain file. Returns null when the file does not exist. */
export function loadBrain(filePath: string): BrainFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<BrainFile>;
  const version = typeof parsed.version === 'number' ? parsed.version : BRAIN_VERSION;
  if (version > BRAIN_VERSION) throw new BrainVersionError(filePath, version);
  return {
    version: BRAIN_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as BrainNode[]) : [],
    edges: Array.isArray(parsed.edges) ? (parsed.edges as BrainEdge[]) : [],
  };
}

/**
 * Atomic write: temp file in the same dir, fsync, rename over the target, with
 * the Windows EPERM/EBUSY retry loop (Defender and indexers briefly hold files).
 * Shared by saveBrain and the vector sidecar — do not reimplement the retry.
 *
 * `mode` is applied to the TEMP file at creation, so the renamed result is
 * never briefly world-readable. serve.json (which holds bearer tokens) passes
 * 0600; saveServeConfig also chmods afterwards to defeat a restrictive umask.
 */
export function writeFileAtomic(filePath: string, text: string, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.brain.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr: unknown;
  for (let i = 0; i < RENAME_RETRIES; i++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      lastErr = err;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      sleep(RENAME_BACKOFF_MS * (i + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best effort */
  }
  throw lastErr;
}

/** Atomic save: write temp file in the same dir, fsync, rename over the target. */
export function saveBrain(filePath: string, brain: BrainFile): void {
  brain.updatedAt = new Date().toISOString();
  writeFileAtomic(filePath, JSON.stringify(brain, null, 2) + '\n');
}

function lockDir(filePath: string): string {
  return `${filePath}.lock`;
}

/** Take the lock (a directory beside the file). Steals locks older than 10s. */
export function acquireLock(filePath: string, timeoutMs = 5_000): () => void {
  const lock = lockDir(filePath);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      } catch {
        /* informational only */
      }
      return () => {
        try {
          fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // vanished between mkdir and stat — retry immediately
      }
      if (stale) {
        try {
          fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          /* raced another staleness reaper */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      sleep(100);
    }
  }
}

/** load → mutate → save under the lock. Creates an empty brain when missing. */
export function mutateBrain<T>(filePath: string, fn: (brain: BrainFile) => T): T {
  const release = acquireLock(filePath);
  try {
    const brain = loadBrain(filePath) ?? emptyBrain();
    const result = fn(brain);
    saveBrain(filePath, brain);
    return result;
  } finally {
    release();
  }
}

export function isLockStale(filePath: string): boolean | null {
  try {
    const st = fs.statSync(lockDir(filePath));
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    return null; // no lock at all
  }
}

// ── graph helpers shared by recall / distill / merge / UI ────────────────────
// Moved to brainGraph.ts (pure, browser-safe subpath) so the Chrome extension's
// standalone brain can use them; re-exported here so node callers are untouched.

export * from './brainGraph.js';
