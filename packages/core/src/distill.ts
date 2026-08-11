// The POST-session write, ported from the worker's brain/distill.ts (legacy
// delta path — no supervisor here). One tool-less LLM call reads the transcript
// and proposes nodes/edges as STRICT JSON; the delta is applied with the same
// rules: refine-by-id, capped new-node growth, edges only between real nodes.

import type { OneShot } from './claude.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import { upsertEdge, upsertNode } from './store.js';
import {
  CATEGORIES,
  CATEGORY_HINTS,
  asCategory,
  placeNode,
  slug,
  type BrainFile,
  type BrainNode,
} from './types.js';

export interface RawNode {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  content?: unknown;
}
export interface RawEdge {
  from?: unknown;
  to?: unknown;
  strength?: unknown;
}
export interface RawDelta {
  nodes?: RawNode[];
  edges?: RawEdge[];
}

// Tolerant JSON extraction: strip prose / code fences, take the outermost object.
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export interface DistillPromptParams {
  taskText: string;
  transcript: string;
  knownNodes: BrainNode[]; // full current graph or the recalled subset
  maxNewNodes: number;
  maxTranscriptChars: number;
}

export function buildDistillPrompt(p: DistillPromptParams): string {
  const known = p.knownNodes.length
    ? p.knownNodes.map((n) => `- id="${n.id}" [${n.category}] ${n.title}`).join('\n')
    : '(none yet)';

  return [
    `${NFF_PROMPT_MARKERS.distill} for a coding agent working on this project.`,
    `A session just finished. Extract ONLY durable, reusable knowledge worth keeping as the`,
    `agent's future skills/playbooks — procedures, fault→fix mappings, project conventions,`,
    `gotchas, strategies that will help on similar future tasks. IGNORE one-off facts,`,
    `chit-chat, and anything specific to a single moment that won't generalize. If nothing`,
    `is worth saving, return {"nodes":[],"edges":[]}.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence) of shape:`,
    `{"nodes":[{"id","title","category","content"}],"edges":[{"from","to","strength"}]}`,
    `Rules:`,
    `- category must be one of: ${CATEGORIES.join(' | ')}`,
    ...CATEGORIES.map((c) => `    ${c} — ${CATEGORY_HINTS[c]}`),
    `- content = an actionable procedure/lesson in 1-4 sentences ("When X, do Y because Z").`,
    `- To REFINE existing knowledge, reuse that node's exact id (see KNOWN NODES). Otherwise`,
    `  invent a short kebab-case id. At most ${p.maxNewNodes} NEW nodes.`,
    `- edges connect related node ids (from/to may reference KNOWN NODES too); strength 0..1.`,
    ``,
    `KNOWN NODES (already in the brain):`,
    known,
    ``,
    `TASK:`,
    p.taskText.slice(0, 2000),
    ``,
    `SESSION TRANSCRIPT (truncated):`,
    p.transcript.slice(0, p.maxTranscriptChars),
  ].join('\n');
}

export interface ApplyDeltaOptions {
  maxNewNodes: number;
  sessionId?: string | null;
  origin?: 'seed' | 'agent';
  now?: Date;
}

/** Apply a distilled delta to an in-memory brain. Returns the ids written. */
export function applyDelta(brain: BrainFile, delta: RawDelta, opts: ApplyDeltaOptions): Set<string> {
  const now = opts.now ?? new Date();
  const knownIds = new Set(brain.nodes.map((n) => n.id));
  const writtenIds = new Set<string>();
  let newCount = 0;

  for (const rn of delta.nodes ?? []) {
    const title = typeof rn.title === 'string' ? rn.title.trim() : '';
    const content = typeof rn.content === 'string' ? rn.content.trim() : '';
    if (!title || !content) continue;
    const id = slug(typeof rn.id === 'string' && rn.id.trim() ? rn.id : title);
    if (!id) continue;
    const isNew = !knownIds.has(id);
    if (isNew && newCount >= opts.maxNewNodes) continue; // cap fresh growth per run
    if (isNew) newCount += 1;

    const category = asCategory(rn.category);
    const existing = brain.nodes.find((n) => n.id === id);
    const node: BrainNode = {
      id,
      title: title.slice(0, 80),
      category,
      content: content.slice(0, 1200),
      // A refine keeps the node's place on the board; only new nodes get placed.
      ...(existing
        ? { color: existing.color, x: existing.x, y: existing.y, size: existing.size, origin: existing.origin }
        : { ...placeNode(category), origin: opts.origin ?? 'agent' }),
      sourceSession: opts.sessionId ?? existing?.sourceSession,
      lastUpdated: now.toISOString(),
      recallCount: existing?.recallCount ?? 0,
      lastRecalledAt: existing?.lastRecalledAt,
    };
    upsertNode(brain, node);
    writtenIds.add(id);
    knownIds.add(id);
  }

  // Edges may link new nodes to each other or to existing nodes. Both endpoints
  // must resolve to a real node.
  for (const re of delta.edges ?? []) {
    const from = typeof re.from === 'string' ? slug(re.from) : '';
    const to = typeof re.to === 'string' ? slug(re.to) : '';
    if (!knownIds.has(from) || !knownIds.has(to) || from === to) continue;
    const strength =
      typeof re.strength === 'number' && re.strength >= 0 && re.strength <= 1 ? re.strength : 0.6;
    upsertEdge(brain, { from, to, strength });
  }

  return writtenIds;
}

export interface DistillParams {
  taskText: string;
  transcript: string;
  sessionId?: string | null;
  oneShot: OneShot;
  maxNewNodes?: number;
  maxTranscriptChars?: number;
}

/** Run the distiller LLM call and apply its delta. Returns the ids written. */
export async function distill(brain: BrainFile, p: DistillParams): Promise<Set<string>> {
  const prompt = buildDistillPrompt({
    taskText: p.taskText,
    transcript: p.transcript,
    knownNodes: brain.nodes,
    maxNewNodes: p.maxNewNodes ?? 3,
    maxTranscriptChars: p.maxTranscriptChars ?? 12_000,
  });
  const raw = await p.oneShot(prompt);
  const delta = extractJson<RawDelta>(raw);
  if (!delta) return new Set();
  return applyDelta(brain, delta, { maxNewNodes: p.maxNewNodes ?? 3, sessionId: p.sessionId });
}

/**
 * GLOBAL BUDGET: evict the least-valuable agent nodes past the cap so the graph
 * stays bounded. Seeds are never evicted. Returns the number evicted.
 */
export function pruneBrain(brain: BrainFile, maxTotalNodes: number): number {
  // graphify imports don't count toward the budget (they're bounded per repo and
  // replaced wholesale on re-ingest) and are never eviction victims.
  const countable = brain.nodes.filter((n) => n.origin !== 'graphify').length;
  if (maxTotalNodes <= 0 || countable <= maxTotalNodes) return 0;
  const excess = countable - maxTotalNodes;
  const victims = brain.nodes
    .filter((n) => n.origin !== 'seed' && n.origin !== 'graphify' && n.category !== 'core')
    .sort((a, b) => {
      if ((a.recallCount ?? 0) !== (b.recallCount ?? 0)) return (a.recallCount ?? 0) - (b.recallCount ?? 0);
      const at = Date.parse(a.lastRecalledAt ?? a.lastUpdated) || 0;
      const bt = Date.parse(b.lastRecalledAt ?? b.lastUpdated) || 0;
      return at - bt;
    })
    .slice(0, excess);
  const victimIds = new Set(victims.map((n) => n.id));
  brain.nodes = brain.nodes.filter((n) => !victimIds.has(n.id));
  brain.edges = brain.edges.filter((e) => !victimIds.has(e.from) && !victimIds.has(e.to));
  return victims.length;
}
