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

/** Atomic save: write temp file in the same dir, fsync, rename over the target. */
export function saveBrain(filePath: string, brain: BrainFile): void {
  brain.updatedAt = new Date().toISOString();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.brain.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(brain, null, 2) + '\n');
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

export function upsertNode(brain: BrainFile, node: BrainNode): void {
  const i = brain.nodes.findIndex((n) => n.id === node.id);
  if (i >= 0) brain.nodes[i] = node;
  else brain.nodes.push(node);
}

/** Overwrite strength with the latest value (single-writer semantics, like the worker). */
export function upsertEdge(brain: BrainFile, edge: BrainEdge): void {
  const i = brain.edges.findIndex(
    (e) => (e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from),
  );
  if (i >= 0) brain.edges[i] = { ...brain.edges[i], strength: edge.strength };
  else brain.edges.push(edge);
}

export function removeNode(brain: BrainFile, id: string): boolean {
  const before = brain.nodes.length;
  brain.nodes = brain.nodes.filter((n) => n.id !== id);
  brain.edges = brain.edges.filter((e) => e.from !== id && e.to !== id);
  return brain.nodes.length < before;
}

export function nodeDegree(brain: BrainFile, id: string): number {
  return brain.edges.reduce((d, e) => d + (e.from === id || e.to === id ? 1 : 0), 0);
}

/** Merge project + global graphs for recall/UI. Project wins on id collision. */
export interface MergedBrain {
  nodes: BrainNode[];
  edges: BrainEdge[];
  /** Which file each node came from — mutations must route back to it. */
  sourceById: Map<string, 'project' | 'global'>;
}

export function mergeBrains(project: BrainFile | null, global: BrainFile | null): MergedBrain {
  const sourceById = new Map<string, 'project' | 'global'>();
  const nodes: BrainNode[] = [];
  for (const n of project?.nodes ?? []) {
    nodes.push(n);
    sourceById.set(n.id, 'project');
  }
  for (const n of global?.nodes ?? []) {
    if (!sourceById.has(n.id)) {
      nodes.push(n);
      sourceById.set(n.id, 'global');
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  const seenPair = new Set<string>();
  const edges: BrainEdge[] = [];
  for (const e of [...(project?.edges ?? []), ...(global?.edges ?? [])]) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue; // both endpoints must exist
    const key = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`;
    if (seenPair.has(key)) continue; // project edge wins (iterated first)
    seenPair.add(key);
    edges.push(e);
  }
  return { nodes, edges, sourceById };
}
