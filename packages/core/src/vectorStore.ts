import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { vectorsPath } from './paths.js';
import type { BrainPaths } from './paths.js';
import { acquireLock, writeFileAtomic } from './store.js';
import type { BrainFile, BrainNode } from './types.js';
import { decodeVector, encodeVector } from './vector.js';

// NODE-ONLY. Persists node embeddings in a sidecar beside each brain file.
//
// This module NEVER imports embed.ts — the embedder arrives as a function
// parameter, the same injection convention as OneShot in distill.ts and
// mergePass.ts. That is what lets the tests exercise every path with a
// deterministic fake and no model, no network, no mocking framework.

export const VECTORS_VERSION = 1;

export type EmbedBatch = (texts: string[]) => Promise<(Float32Array | null)[]>;

export interface VectorEntry {
  /** Content hash — staleness detection without timestamps. */
  h: string;
  /** base64 little-endian float32, unit-normalised. */
  v: string;
}

export interface VectorFile {
  version: number;
  model: string;
  dim: number;
  updatedAt: string;
  nodes: Record<string, VectorEntry>;
}

/** The text an embedding represents. Title first — it carries the most signal. */
export function embedText(node: Pick<BrainNode, 'title' | 'content'>): string {
  return `${node.title}\n\n${node.content}`;
}

/**
 * Model id is inside the hash so switching models invalidates every node even
 * if the header check is somehow bypassed.
 */
export function contentHash(model: string, node: Pick<BrainNode, 'title' | 'content'>): string {
  return createHash('sha256')
    .update(`${model}\0${node.title}\0${node.content}`)
    .digest('hex')
    .slice(0, 16);
}

/** Read the sidecar. Returns null when absent, unreadable or malformed. */
export function loadVectors(brainPath: string): VectorFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(vectorsPath(brainPath), 'utf8');
  } catch {
    return null; // absent is the normal case, not an error
  }
  try {
    const p = JSON.parse(raw) as Partial<VectorFile>;
    if (typeof p.model !== 'string' || typeof p.dim !== 'number') return null;
    if (p.version !== VECTORS_VERSION) return null; // derived data: rebuild, never migrate
    if (!p.nodes || typeof p.nodes !== 'object') return null;
    return {
      version: VECTORS_VERSION,
      model: p.model,
      dim: p.dim,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date(0).toISOString(),
      nodes: p.nodes as Record<string, VectorEntry>,
    };
  } catch {
    return null; // a torn/corrupt sidecar costs one reindex, never a node
  }
}

export interface VectorPlan {
  fresh: string[];
  stale: string[];
  /** Present in the sidecar but no longer in the brain. */
  orphaned: string[];
}

/** Diff a brain against its sidecar. Pure — no I/O, no model. */
export function vectorPlan(brain: BrainFile, vf: VectorFile | null, model: string): VectorPlan {
  const fresh: string[] = [];
  const stale: string[] = [];
  // A header mismatch invalidates everything: partial reuse across models would
  // mix incomparable vector spaces, which degrades silently.
  const usable = vf && vf.model === model ? vf : null;
  for (const n of brain.nodes) {
    const entry = usable?.nodes[n.id];
    if (entry && entry.h === contentHash(model, n)) fresh.push(n.id);
    else stale.push(n.id);
  }
  const ids = new Set(brain.nodes.map((n) => n.id));
  const orphaned = Object.keys(vf?.nodes ?? {}).filter((id) => !ids.has(id));
  return { fresh, stale, orphaned };
}

export interface IndexResult {
  embedded: number;
  reused: number;
  pruned: number;
  failed: number;
  model: string;
  dim: number;
}

/**
 * Bring the sidecar up to date. Only stale nodes are embedded.
 *
 * Deliberately NOT wired into mutateBrain: that is synchronous, holds the brain
 * lock, and sits on the recall hot path (bumpRecall). Indexing is an explicit
 * or post-write operation.
 */
export async function indexBrain(
  brainPath: string,
  brain: BrainFile,
  embed: EmbedBatch,
  opts: { model: string; dim?: number; force?: boolean },
): Promise<IndexResult> {
  const model = opts.model;
  const existing = loadVectors(brainPath);
  const plan = vectorPlan(brain, existing, model);
  const stale = new Set(plan.stale);
  const targets = opts.force ? brain.nodes : brain.nodes.filter((n) => stale.has(n.id));

  const nodes: Record<string, VectorEntry> = {};
  if (!opts.force && existing && existing.model === model) {
    for (const id of plan.fresh) {
      const e = existing.nodes[id];
      if (e) nodes[id] = e;
    }
  }

  let failed = 0;
  let dim = opts.dim ?? existing?.dim ?? 0;
  if (targets.length > 0) {
    const vecs = await embed(targets.map(embedText));
    for (let i = 0; i < targets.length; i++) {
      const node = targets[i]!;
      const v = vecs[i];
      if (!v) {
        failed++;
        continue;
      }
      if (!dim) dim = v.length;
      nodes[node.id] = { h: contentHash(model, node), v: encodeVector(v) };
    }
  }

  // Nothing embedded and nothing reusable ⇒ the embedder is unavailable. Do not
  // write an empty sidecar over a good one.
  if (Object.keys(nodes).length === 0 && failed > 0) {
    return { embedded: 0, reused: 0, pruned: 0, failed, model, dim };
  }

  const file: VectorFile = {
    version: VECTORS_VERSION,
    model,
    dim: dim || 0,
    updatedAt: new Date().toISOString(),
    nodes,
  };
  const target = vectorsPath(brainPath);
  const release = acquireLock(target);
  try {
    writeFileAtomic(target, JSON.stringify(file) + '\n');
  } finally {
    release();
  }
  ensureGitignore(target);

  const reused = Object.keys(nodes).length - (targets.length - failed);
  return {
    embedded: targets.length - failed,
    reused: Math.max(0, reused),
    pruned: plan.orphaned.length,
    failed,
    model,
    dim: file.dim,
  };
}

/**
 * Project brains are meant to be committed and shared; an ~840 KB derived blob
 * is not. Best effort — never fails the index.
 */
function ensureGitignore(vectorsFile: string): void {
  try {
    const gi = path.join(path.dirname(vectorsFile), '.gitignore');
    const name = path.basename(vectorsFile);
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (existing.split(/\r?\n/).some((l) => l.trim() === name)) return;
    fs.writeFileSync(gi, existing && !existing.endsWith('\n') ? `${existing}\n${name}\n` : `${existing}${name}\n`);
  } catch {
    /* best effort */
  }
}

/** Decode one sidecar into an id → unit-vector map. */
export function decodeVectors(vf: VectorFile | null): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!vf) return out;
  for (const [id, entry] of Object.entries(vf.nodes)) {
    const v = decodeVector(entry?.v ?? '', vf.dim || undefined);
    if (v) out.set(id, v);
  }
  return out;
}

export interface QueryVectors {
  vectors: Map<string, Float32Array>;
  model: string | null;
  dim: number;
  /** Set when the global sidecar was ignored because it disagrees on model/dim. */
  mismatch: string | null;
}

/**
 * Merged vector view for search. Follows mergeBrains' precedence: the project
 * sidecar wins, global fills only ids the project didn't claim. A global
 * sidecar built with a different model is IGNORED rather than mixed in —
 * comparing vectors across models is meaningless, and doctor reports it.
 */
export function queryVectors(paths: Pick<BrainPaths, 'project' | 'global'>): QueryVectors {
  const proj = loadVectors(paths.project);
  const glob = loadVectors(paths.global);
  const model = proj?.model ?? glob?.model ?? null;
  const dim = proj?.dim ?? glob?.dim ?? 0;

  const vectors = decodeVectors(proj);
  let mismatch: string | null = null;
  if (glob) {
    if (proj && (glob.model !== proj.model || glob.dim !== proj.dim)) {
      mismatch = `global vectors use ${glob.model} (${glob.dim}d), project uses ${proj.model} (${proj.dim}d) — global ignored`;
    } else {
      for (const [id, v] of decodeVectors(glob)) if (!vectors.has(id)) vectors.set(id, v);
    }
  }
  return { vectors, model, dim, mismatch };
}
