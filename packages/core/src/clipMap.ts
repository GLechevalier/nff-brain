// The drain's ledger: .nff-brain/clip-map.jsonl beside a brain file, one line
// per PROCESSED clip recording which node(s) it minted. Three consumers:
//
//   1. The drain itself — a clipId already ledgered is never re-distilled,
//      which is the id-keyed dedupe the queue's at-least-once delivery assumes
//      (clipQueue.ts's "the distiller's id-keyed upsert absorbs" comment).
//      `nodeIds: []` is meaningful: processed, judged worthless — still deduped.
//   2. GET /v1/clips/map — the extension polls this to fill ActivityRecord
//      .nodeIds, which is what makes the popup's "also remove nodes" real.
//   3. POST /v1/retract — attribution: a client may only retract nodes its own
//      clips created.
//
// Same locking discipline as clipQueue.ts (multi-writer: drain + serve).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { brainLogPath } from './paths.js';
import { acquireLock } from './store.js';

export const CLIP_MAP_FILE = 'clip-map.jsonl';
export const MAX_CLIP_MAP_BYTES = 256 * 1024;

export interface ClipMapEntry {
  v: 1;
  at: string; // ISO — when the drain processed this clip
  clipId: string;
  clientId?: string;
  nodeIds: string[];
}

export function clipMapPath(brainPath: string): string {
  return brainLogPath(brainPath, CLIP_MAP_FILE);
}

function parseClipMapLines(chunk: string): ClipMapEntry[] {
  const out: ClipMapEntry[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as ClipMapEntry;
      if (
        e !== null &&
        typeof e === 'object' &&
        e.v === 1 &&
        typeof e.clipId === 'string' &&
        typeof e.at === 'string' &&
        Array.isArray(e.nodeIds) &&
        e.nodeIds.every((id) => typeof id === 'string')
      ) {
        out.push(e);
      }
    } catch {
      /* torn tail or garbage line — skip, never throw */
    }
  }
  return out;
}

export interface AppendClipMapInput {
  clipId: string;
  clientId?: string;
  nodeIds: string[];
}

export function appendClipMap(brainPath: string, entries: readonly AppendClipMapInput[], now = new Date()): void {
  if (entries.length === 0) return;
  const file = clipMapPath(brainPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = now.toISOString();
  const lines = entries
    .map((e) =>
      JSON.stringify({
        v: 1 as const,
        at,
        clipId: e.clipId,
        ...(e.clientId ? { clientId: e.clientId } : {}),
        nodeIds: e.nodeIds,
      }),
    )
    .join('\n');
  const release = acquireLock(file);
  try {
    fs.appendFileSync(file, lines + '\n');
  } finally {
    release();
  }
}

export interface ReadClipMapFilter {
  clientId?: string;
  since?: string; // ISO — keep entries with at > since
}

export function readClipMap(brainPath: string, filter?: ReadClipMapFilter): ClipMapEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(clipMapPath(brainPath), 'utf8');
  } catch {
    return [];
  }
  let entries = parseClipMapLines(raw);
  if (filter?.clientId !== undefined) entries = entries.filter((e) => e.clientId === filter.clientId);
  if (filter?.since !== undefined) {
    const cutoff = Date.parse(filter.since);
    if (Number.isFinite(cutoff)) entries = entries.filter((e) => (Date.parse(e.at) || 0) > cutoff);
  }
  return entries;
}

/** The drain's dedupe set. Includes worthless (`nodeIds: []`) clips on purpose. */
export function seenClipIds(brainPath: string): Set<string> {
  return new Set(readClipMap(brainPath).map((e) => e.clipId));
}

export interface CompactClipMapOptions {
  /** Node ids that no longer exist (evicted or retracted) — stripped from entries. */
  dropNodeIds?: ReadonlySet<string>;
}

/**
 * Rewrite the ledger: strip dead node ids and, when over the byte cap, keep the
 * newest lines that fit. Losing OLD ledger lines is safe — their clips are long
 * gone from the queue, so the dedupe they provided can never fire again.
 */
export function compactClipMap(brainPath: string, opts: CompactClipMapOptions = {}): void {
  const file = clipMapPath(brainPath);
  const release = acquireLock(file);
  try {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let entries = parseClipMapLines(raw);
    if (opts.dropNodeIds && opts.dropNodeIds.size > 0) {
      const drop = opts.dropNodeIds;
      entries = entries.map((e) =>
        e.nodeIds.some((id) => drop.has(id))
          ? { ...e, nodeIds: e.nodeIds.filter((id) => !drop.has(id)) }
          : e,
      );
    }
    let lines = entries.map((e) => JSON.stringify(e));
    let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
    while (bytes > MAX_CLIP_MAP_BYTES && lines.length > 0) {
      bytes -= Buffer.byteLength(lines[0], 'utf8') + 1;
      lines = lines.slice(1);
    }
    fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
  } finally {
    release();
  }
}
