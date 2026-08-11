// The extraction half of `nff-brain import`: turn ONE past session transcript
// into candidate memories.
//
// Shape of the LLM contract: five NAMED ARRAYS rather than a free-form `kind`
// field on each entry. A model cannot invent a taxonomy value it never types,
// and the parser cannot mis-route an entry it read out of a known key — so the
// five kinds the user asked for stay five kinds.

import { extractJson } from './distill.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import { CATEGORY_HINTS, type BrainNode, type Category } from './types.js';

export const IMPORT_KINDS = ['memory', 'decision', 'preference', 'task', 'failure'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/**
 * Five extraction kinds onto seven categories.
 *
 * `failure` folds into `analysis` deliberately: "we tried X, it failed because
 * Y" IS an analysis finding, and a separate category would give the palette two
 * overlapping buckets with no distinct recall behaviour.
 */
export const CATEGORY_BY_KIND: Record<ImportKind, Category> = {
  memory: 'strategy',
  decision: 'decision',
  preference: 'preference',
  task: 'task',
  failure: 'analysis',
};

/** The JSON key each kind is returned under. */
export const ARRAY_BY_KIND: Record<ImportKind, string> = {
  memory: 'memories',
  decision: 'decisions',
  preference: 'preferences',
  task: 'tasks',
  failure: 'failures',
};

const KIND_BRIEF: Record<ImportKind, string> = {
  memory: 'durable procedures and gotchas. "When X, do Y because Z."',
  decision:
    'an architectural choice that was MADE and stuck, with its reason. "We use X instead of Y because Z." Not options merely considered.',
  preference:
    'how THIS developer wants to work: style, tools, tone, review habits. Only when stated outright or enforced repeatedly — never inferred from one instance.',
  task: 'work explicitly deferred and still open at session end ("TODO", "let\'s do that later"). Skip anything the session finished.',
  failure:
    'an approach that was tried and did NOT work, and why. The most valuable kind: it stops the agent repeating the mistake.',
};

export interface SessionRef {
  sessionId: string;
  title: string | null;
  date: string | null; // ISO date the session ended
}

export interface Proposal {
  kind: ImportKind;
  category: Category;
  title: string;
  content: string;
  confidence: number; // after heuristics
  llmConfidence: number; // as returned, for debugging
  sources: SessionRef[]; // exactly one until clustering merges them
}

export const MAX_TITLE = 80;
export const MAX_CONTENT = 600;

export interface ImportPromptParams {
  taskText: string;
  transcript: string;
  knownNodes: readonly BrainNode[];
  maxPerKind: number;
  maxTranscriptChars: number;
  sessionLabel?: string;
}

export function buildImportPrompt(p: ImportPromptParams): string {
  const known = p.knownNodes.length
    ? p.knownNodes.map((n) => `- [${n.category}] ${n.title}`).join('\n')
    : '(the brain is empty — everything is new)';

  const arrays = IMPORT_KINDS.map((k) => `"${ARRAY_BY_KIND[k]}":[…]`).join(',');

  return [
    `${NFF_PROMPT_MARKERS.archaeologist} for a coding agent.`,
    `Below is a PAST Claude Code session. Mine it for knowledge worth remembering`,
    `FOREVER — things that will still be true and useful months from now.`,
    `Most sessions yield little or nothing. Empty arrays are the RIGHT answer when`,
    `the session was routine; do not pad.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{${arrays}}`,
    `Every entry is {"title":"≤${MAX_TITLE} chars","content":"≤${MAX_CONTENT} chars","confidence":0..1}.`,
    ``,
    ...IMPORT_KINDS.map(
      (k) => `  ${ARRAY_BY_KIND[k].padEnd(12)}— ${KIND_BRIEF[k]} (stored as category "${CATEGORY_BY_KIND[k]}": ${CATEGORY_HINTS[CATEGORY_BY_KIND[k]]})`,
    ),
    ``,
    `confidence: 0.9 the user stated it as a rule · 0.7 demonstrated and confirmed`,
    `in the session · 0.4 you inferred it. Be honest — low confidence is not punished,`,
    `it just means the human reviews it before it is kept.`,
    ``,
    `At most ${p.maxPerKind} entries per array. Write each entry so it stands ALONE:`,
    `a future agent reads it with no access to this session, so "the bug we fixed"`,
    `means nothing — name the thing.`,
    `Do NOT restate anything already in KNOWN KNOWLEDGE; skip it silently.`,
    ``,
    `KNOWN KNOWLEDGE (already in the brain):`,
    known,
    ``,
    `SESSION${p.sessionLabel ? `: ${p.sessionLabel}` : ''}`,
    `OPENING REQUEST:`,
    (p.taskText || '(none recorded)').slice(0, 2000),
    ``,
    `TRANSCRIPT (head and tail; the middle is omitted):`,
    p.transcript.slice(0, p.maxTranscriptChars),
  ].join('\n');
}

interface RawEntry {
  title?: unknown;
  content?: unknown;
  confidence?: unknown;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * A model that ignores the rubric and writes "high" / "medium" still tells us
 * something; map the common words rather than dropping to the default.
 */
function readConfidence(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Some models answer 0..100 despite the rubric.
    return clamp01(v > 1 ? v / 100 : v);
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    const asNum = Number(s);
    if (Number.isFinite(asNum) && s !== '') return clamp01(asNum > 1 ? asNum / 100 : asNum);
    if (s.startsWith('high') || s === 'certain') return 0.9;
    if (s.startsWith('med')) return 0.6;
    if (s.startsWith('low')) return 0.35;
  }
  return 0.5;
}

/** Signals that the session argued with itself — the reasoning was contested. */
// Each alternative carries its own boundaries: a trailing \b after "no," can
// never match, because a comma and the space after it are both non-word chars.
const CORRECTION =
  /\bno,|\bnope\b|\bactually\b|\bthat'?s wrong\b|\bdon'?t do that\b|\brevert\b|\bundo that\b|\bwrong\b/i;

export function hasCorrection(transcript: string): boolean {
  for (const line of transcript.split('\n')) {
    if (line.startsWith('[user] ') && CORRECTION.test(line)) return true;
  }
  return false;
}

export interface ConfidenceContext {
  transcriptChars: number;
  hasCorrection: boolean;
  ageDays: number;
}

/**
 * Temper the model's self-reported confidence with things it cannot see.
 *
 * Deliberately gentle and multiplicative — this decides which items start
 * CHECKED in the preview, not which items exist, so being slightly too cautious
 * costs the user an extra checkbox, never a lost memory.
 */
export function adjustConfidence(raw: number, kind: ImportKind, ctx: ConfidenceContext): number {
  let c = clamp01(raw);
  // A short session had less chance to prove anything.
  c *= 0.75 + 0.25 * Math.min(1, ctx.transcriptChars / 8000);
  // Someone pushed back mid-session, so the reasoning behind it was contested.
  if (ctx.hasCorrection && (kind === 'memory' || kind === 'failure')) c *= 0.85;
  // A TODO deferred two months ago has probably been done, dropped or forgotten.
  if (kind === 'task' && ctx.ageDays > 30) c *= 0.9;
  return clamp01(Number(c.toFixed(4)));
}

export interface ParseContext {
  session: SessionRef;
  transcriptChars: number;
  hasCorrection: boolean;
  ageDays: number;
  maxPerKind?: number;
}

/**
 * Parse one session's response into proposals. Tolerant by design: a missing
 * array, a stray prose preamble, or an entry lacking a body all cost that one
 * entry, never the session.
 */
export function parseImportResponse(raw: string, ctx: ParseContext): Proposal[] {
  const doc = extractJson<Record<string, unknown>>(raw);
  if (!doc) return [];
  const out: Proposal[] = [];
  const cap = ctx.maxPerKind ?? Infinity;

  for (const kind of IMPORT_KINDS) {
    const arr = doc[ARRAY_BY_KIND[kind]];
    if (!Array.isArray(arr)) continue;
    let taken = 0;
    for (const item of arr) {
      if (taken >= cap) break;
      if (!item || typeof item !== 'object') continue;
      const e = item as RawEntry;
      const title = typeof e.title === 'string' ? e.title.trim() : '';
      const content = typeof e.content === 'string' ? e.content.trim() : '';
      if (!title || !content) continue;
      const llmConfidence = readConfidence(e.confidence);
      out.push({
        kind,
        category: CATEGORY_BY_KIND[kind],
        title: title.slice(0, MAX_TITLE),
        content: content.slice(0, MAX_CONTENT),
        llmConfidence,
        confidence: adjustConfidence(llmConfidence, kind, {
          transcriptChars: ctx.transcriptChars,
          hasCorrection: ctx.hasCorrection,
          ageDays: ctx.ageDays,
        }),
        sources: [ctx.session],
      });
      taken += 1;
    }
  }
  return out;
}

/** Whole days between an ISO date and now; 0 when the date is unusable. */
export function ageDaysOf(iso: string | null | undefined, now = new Date()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
