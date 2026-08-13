// The clip drain's pure half: turn a batch of queued browser captures into
// proposed brain nodes. Modeled on importExtract.ts — the LLM returns NAMED
// ARRAYS keyed by category rather than a free-form `category` field, so the
// model cannot invent a taxonomy value and the parser cannot mis-route an
// entry it read out of a known key. There is deliberately no `core` array:
// a browser clip can never become a hub node (or win the spine's root lottery).
//
// Clips are index-addressed in the prompt (#0, #1, …). Clip ids never reach
// the model; the parser translates indices back. `i` may be an array, which is
// how several selections from one page fold into ONE node.

import { extractJson } from './jsonExtract.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import { CATEGORY_HINTS, type BrainNode, type Category } from './types.js';
import type { ClipRecord } from './clip.js';

/** Every category a clip node may take — all of them except 'core'. */
export const CLIP_CATEGORIES = [
  'strategy',
  'analysis',
  'rules',
  'decision',
  'preference',
  'task',
] as const;
export type ClipCategory = (typeof CLIP_CATEGORIES)[number];

export const CLIP_TITLE_MAX = 80;
export const CLIP_CONTENT_MAX = 600;

export interface ClipProposal {
  category: Category;
  title: string;
  content: string;
  /** Queue ids of every clip folded into this node. Never shown to the model. */
  clipIds: string[];
}

export interface ClipDuplicate {
  clipId: string;
  /** Existing clip-node id the model says this capture already restates. */
  of: string;
}

export interface ParsedClipResponse {
  proposals: ClipProposal[];
  duplicates: ClipDuplicate[];
}

export interface ClipPromptParams {
  clips: readonly ClipRecord[];
  /** Existing origin:'clip' nodes, so the model can flag re-captures. */
  knownClipNodes: readonly Pick<BrainNode, 'id' | 'title' | 'sourceUrl'>[];
}

function clipLine(c: ClipRecord, i: number): string {
  const where = c.url ? ` ${c.url}` : '';
  const titled = c.title ? ` "${c.title}"` : '';
  const note = c.note ? ` (note: ${c.note})` : '';
  const body = c.text ? `: ${c.text}` : '';
  return `#${i} [${c.kind}]${where}${titled}${body}${note}`;
}

export function buildClipPrompt(p: ClipPromptParams): string {
  const known = p.knownClipNodes.length
    ? p.knownClipNodes
        .map((n) => `- id="${n.id}" ${n.title}${n.sourceUrl ? ` (${n.sourceUrl})` : ''}`)
        .join('\n')
    : '(none yet)';

  const arrays = CLIP_CATEGORIES.map((c) => `"${c}":[…]`).join(',');

  return [
    `${NFF_PROMPT_MARKERS.clipper} for a coding agent's knowledge brain.`,
    `Below are snippets the user explicitly captured while browsing — a selection,`,
    `a link, or a whole page they right-clicked "Remember this" on. Turn them into`,
    `durable notes the agent can recall in future coding sessions.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{${arrays},"duplicate":[{"i":0,"of":"<known clip id>"}]}`,
    `Every entry is {"i": <clip index or array of indices>, "title":"≤${CLIP_TITLE_MAX} chars", "content":"≤${CLIP_CONTENT_MAX} chars"}.`,
    `Category meanings:`,
    ...CLIP_CATEGORIES.map((c) => `  ${c.padEnd(10)} — ${CATEGORY_HINTS[c]}`),
    ``,
    `Rules:`,
    `- "i" says which clip(s) an entry came from. Several clips from the same page`,
    `  that state one fact belong in ONE entry with "i": [both indices].`,
    `- Write content to stand ALONE: a future agent reads it without the page open,`,
    `  so keep the fact, not the page's prose. Name the thing.`,
    `- A clip that already restates a KNOWN CLIP goes in "duplicate" (its index +`,
    `  the known node's exact id), not in a category array.`,
    `- A clip with no durable value — a cookie banner, lorem, a stray selection —`,
    `  is OMITTED entirely. Dropping worthless clips is the right answer.`,
    ``,
    `KNOWN CLIPS (already in the brain):`,
    known,
    ``,
    `CAPTURED CLIPS:`,
    ...p.clips.map((c, i) => clipLine(c, i)),
  ].join('\n');
}

interface RawClipEntry {
  i?: unknown;
  title?: unknown;
  content?: unknown;
}

/** Translate a raw `i` into in-range clip indices; empty when unusable. */
function readIndices(v: unknown, max: number): number[] {
  const list = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const item of list) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN;
    if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Parse one drain response. Tolerant by design, like parseImportResponse: a
 * missing array, a prose preamble, or an entry with an out-of-range index all
 * cost that one entry, never the batch. Returns null only when nothing parsed
 * at all — the drain must then NOT ledger or finishTake, so the batch retries.
 */
export function parseClipResponse(
  raw: string,
  clips: readonly ClipRecord[],
): ParsedClipResponse | null {
  const doc = extractJson<Record<string, unknown>>(raw);
  if (!doc) return null;

  const proposals: ClipProposal[] = [];
  for (const category of CLIP_CATEGORIES) {
    const arr = doc[category];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const e = item as RawClipEntry;
      const title = typeof e.title === 'string' ? e.title.trim() : '';
      const content = typeof e.content === 'string' ? e.content.trim() : '';
      if (!title || !content) continue;
      const indices = readIndices(e.i, clips.length);
      if (indices.length === 0) continue;
      proposals.push({
        category,
        title: title.slice(0, CLIP_TITLE_MAX),
        content: content.slice(0, CLIP_CONTENT_MAX),
        clipIds: indices.map((i) => clips[i].id),
      });
    }
  }

  const duplicates: ClipDuplicate[] = [];
  const dupArr = doc.duplicate;
  if (Array.isArray(dupArr)) {
    for (const item of dupArr) {
      if (!item || typeof item !== 'object') continue;
      const d = item as { i?: unknown; of?: unknown };
      const of = typeof d.of === 'string' ? d.of.trim() : '';
      if (!of) continue;
      for (const i of readIndices(d.i, clips.length)) {
        duplicates.push({ clipId: clips[i].id, of });
      }
    }
  }

  return { proposals, duplicates };
}
