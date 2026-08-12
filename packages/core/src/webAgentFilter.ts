// The web agent's judgment call: given one page of LinkedIn search-result
// cards, decide which match the goal's criteria. Index-addressed exactly like
// clipDistill.ts — a name is never trusted from the model, only its index —
// and batched once per page rather than once per card, since a page of ~10
// cards is one cheap call and per-card would be 10 separate `claude -p`
// subprocess spawns for what is clearly a batch-classification task.

import { extractJson } from './distill.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';

export const AGENT_CARD_FIELD_MAX = 160;
export const AGENT_FILTER_REASON_MAX = 140;

export interface AgentCard {
  name: string;
  headline: string;
  company?: string;
}

export interface AgentCardMatch {
  index: number;
  reason: string;
}

function cardLine(c: AgentCard, i: number): string {
  const company = c.company ? ` (${c.company})` : '';
  return `#${i} ${c.name} — ${c.headline}${company}`;
}

export function buildFilterPrompt(criteria: string, cards: readonly AgentCard[]): string {
  return [
    `${NFF_PROMPT_MARKERS.agentFilter}. Below is one page of LinkedIn people-search`,
    `results. Decide which of them match this criteria:`,
    ``,
    `CRITERIA: ${criteria}`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{"matches":[{"i":0,"reason":"<=${AGENT_FILTER_REASON_MAX} chars"}]}`,
    ``,
    `Rules:`,
    `- "i" is the card's index below, never its name.`,
    `- Only include a card if it genuinely matches the criteria — when in doubt,`,
    `  leave it out. An empty "matches" array is a valid, correct answer.`,
    ``,
    `CARDS:`,
    ...cards.map((c, i) => cardLine(c, i)),
  ].join('\n');
}

interface RawMatch {
  i?: unknown;
  reason?: unknown;
}

/**
 * Tolerant like parseClipResponse: an out-of-range index or a malformed entry
 * costs that one match, never the batch. Returns [] (not null) when nothing
 * matched or nothing parsed — an empty result is a legitimate "no matches on
 * this page", not a failure the caller needs to distinguish from a parse error.
 */
export function parseFilterResponse(raw: string, cards: readonly AgentCard[]): AgentCardMatch[] {
  const doc = extractJson<Record<string, unknown>>(raw);
  if (!doc || !Array.isArray(doc.matches)) return [];

  const seen = new Set<number>();
  const out: AgentCardMatch[] = [];
  for (const item of doc.matches) {
    if (!item || typeof item !== 'object') continue;
    const m = item as RawMatch;
    const i = typeof m.i === 'number' ? m.i : typeof m.i === 'string' ? Number(m.i) : NaN;
    if (!Number.isInteger(i) || i < 0 || i >= cards.length || seen.has(i)) continue;
    seen.add(i);
    const reason = typeof m.reason === 'string' ? m.reason.trim().slice(0, AGENT_FILTER_REASON_MAX) : '';
    out.push({ index: i, reason });
  }
  return out;
}
