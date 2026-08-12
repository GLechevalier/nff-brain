// The clip queue's pure half: record shape, validation and line parsing. Kept
// free of node:* imports for the same reason activity.ts is — the browser side
// of the protocol wants these limits, and a fs import would break that build.
// The fs half lives in clipQueue.ts.
//
// A clip is NOT a brain node. It is raw captured text waiting for the SessionEnd
// distiller to turn it into one. Nothing here calls an LLM: right-clicking must
// be instant and free, which is the whole reason a queue exists at all.

export type ClipKind = 'selection' | 'link' | 'page' | 'note';
export type ClipTarget = 'global' | 'project';

const KINDS: ReadonlySet<string> = new Set(['selection', 'link', 'page', 'note']);

export const MAX_CLIP_TEXT = 4000;
export const MAX_CLIP_URL = 2000;
export const MAX_CLIP_TITLE = 300;
export const MAX_CLIP_NOTE = 500;
/** Serialized line ceiling. Over this the request is refused, not truncated. */
export const MAX_CLIP_LINE_BYTES = 16 * 1024;

/** What a client is allowed to send. Every field is untrusted. */
export interface ClipInput {
  kind?: unknown;
  text?: unknown;
  url?: unknown;
  title?: unknown;
  note?: unknown;
  capturedAt?: unknown;
  target?: unknown;
}

export interface ClipRecord {
  v: 1;
  /** `clp_<epoch ms>_<6 hex>` — sorts by time without a separate index. */
  id: string;
  /** SERVER receive time. Trusted; used for ordering and retention. */
  at: string;
  /** The client's own claim about when it captured. Untrusted, informational. */
  capturedAt?: string;
  kind: ClipKind;
  text: string;
  url?: string;
  title?: string;
  note?: string;
  target: ClipTarget;
  /** Present only when target === 'project'. */
  workspaceRoot?: string;
  source: string;
  clientId?: string;
}

export function newClipId(nowMs: number, suffix: string): string {
  return `clp_${nowMs}_${suffix}`;
}

/** Drop C0/C1 controls (keeping tab and newline) — they corrupt JSONL readers. */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = stripControls(v).trim().slice(0, max);
  return s.length ? s : undefined;
}

/** http/https only. A javascript:, data: or file: URL is dropped, not stored. */
function safeUrl(v: unknown): string | undefined {
  const raw = str(v, MAX_CLIP_URL);
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return Number.isFinite(Date.parse(v)) ? v : undefined;
}

export interface ClipContext {
  id: string;
  at: string;
  target: ClipTarget;
  source: string;
  workspaceRoot?: string;
  clientId?: string;
}

/**
 * Validate and clamp one client payload. Returns null when there is nothing
 * worth storing (no text and no url) or the kind is unknown. Unknown fields are
 * DROPPED rather than echoed back into the queue.
 */
export function normalizeClip(input: ClipInput, ctx: ClipContext): ClipRecord | null {
  const kind = typeof input.kind === 'string' && KINDS.has(input.kind) ? (input.kind as ClipKind) : null;
  if (!kind) return null;

  const text = str(input.text, MAX_CLIP_TEXT) ?? '';
  const url = safeUrl(input.url);
  if (!text && !url) return null;

  const record: ClipRecord = {
    v: 1,
    id: ctx.id,
    at: ctx.at,
    kind,
    text,
    target: ctx.target,
    source: ctx.source,
  };
  const capturedAt = isoOrUndefined(input.capturedAt);
  if (capturedAt) record.capturedAt = capturedAt;
  if (url) record.url = url;
  const title = str(input.title, MAX_CLIP_TITLE);
  if (title) record.title = title;
  const note = str(input.note, MAX_CLIP_NOTE);
  if (note) record.note = note;
  if (ctx.target === 'project' && ctx.workspaceRoot) record.workspaceRoot = ctx.workspaceRoot;
  if (ctx.clientId) record.clientId = ctx.clientId;
  return record;
}

/**
 * Parse a chunk of clips.jsonl. Tolerant like parseActivityLines: a torn tail,
 * a garbage line, or a record from a future version is skipped, never thrown on.
 */
export function parseClipLines(chunk: string): ClipRecord[] {
  const out: ClipRecord[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const c = JSON.parse(trimmed) as ClipRecord;
      if (
        c !== null &&
        typeof c === 'object' &&
        c.v === 1 &&
        typeof c.id === 'string' &&
        typeof c.at === 'string' &&
        Number.isFinite(Date.parse(c.at)) &&
        typeof c.kind === 'string' &&
        KINDS.has(c.kind) &&
        typeof c.text === 'string'
      ) {
        out.push(c);
      }
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return out;
}
