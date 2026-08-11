// Novelty scoring — how "new" is a task relative to what the brain already
// knows? Weakly-covered queries (no match, or matches only low-degree periphery
// nodes) score high and deserve a frontier model; queries landing on strong,
// well-connected, often-recalled nodes score low and can run on a cheap model.
// Pure lexical/graph math over the merged graph: ZERO LLM calls, no I/O.
//
// Unlike recall there is NO whole-graph bypass here — novelty needs real
// per-node scores even on tiny graphs.

import { scoreNode, tokenize } from './score.js';
import type { BrainEdge, BrainNode } from './types.js';

export const DEFAULT_LADDER = ['haiku', 'sonnet', 'opus'] as const;
export const DEFAULT_THRESHOLDS = [0.35, 0.7] as const;

export interface NoveltyOptions {
  k?: number; // seed nodes considered
  minScore?: number; // lexical relevance floor
  ladder?: string[];
  thresholds?: number[];
}

export interface NoveltyContributor {
  id: string;
  title: string;
  score: number; // lexical relevance to the query
  degree: number; // incident edge count
  strength: number; // 0..1 combined node strength
}

export interface NoveltyResult {
  novelty: number; // 0 = fully familiar … 1 = brand new
  model: string; // picked from the ladder
  ladder: string[];
  thresholds: number[];
  top: NoveltyContributor[];
}

const NOVELTY_DEFAULTS = { k: 6, minScore: 0.05 };

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Session-model ladder from the environment. Separate from NFF_BRAIN_MODEL
 * (the distiller's own model). Malformed values silently fall back so a typo
 * in an env var can never break a hook.
 */
export function modelLadder(env: Record<string, string | undefined> = process.env): {
  ladder: string[];
  thresholds: number[];
} {
  let ladder: string[] = [...DEFAULT_LADDER];
  const rawLadder = env.NFF_BRAIN_MODEL_LADDER;
  if (rawLadder) {
    const parsed = rawLadder.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length >= 1) ladder = parsed;
  }

  // Need exactly ladder.length - 1 ascending cut points in (0, 1).
  let thresholds: number[] | null = null;
  const rawThresholds = env.NFF_BRAIN_NOVELTY_THRESHOLDS;
  if (rawThresholds) {
    const parsed = rawThresholds.split(',').map((s) => Number(s.trim()));
    const valid =
      parsed.length === ladder.length - 1 &&
      parsed.every((n, i) => Number.isFinite(n) && n > 0 && n < 1 && (i === 0 || n > parsed[i - 1]));
    if (valid) thresholds = parsed;
  }
  if (!thresholds) {
    thresholds =
      ladder.length === DEFAULT_LADDER.length
        ? [...DEFAULT_THRESHOLDS]
        : Array.from({ length: ladder.length - 1 }, (_, i) => (i + 1) / ladder.length);
  }
  return { ladder, thresholds };
}

/** First tier whose cut point the novelty stays under; past every cut → last (frontier). */
export function pickModel(novelty: number, ladder: string[], thresholds: number[]): string {
  for (let i = 0; i < thresholds.length; i++) {
    if (novelty < thresholds[i]) return ladder[i];
  }
  return ladder[ladder.length - 1];
}

/**
 * How strong is a node as an anchor of existing knowledge?
 *   0.5 · connectivity (log-damped degree, saturates at 7 links)
 * + 0.3 · strongest incident edge
 * + 0.2 · proven usefulness (log-damped recallCount, saturates at 31 recalls)
 */
function nodeStrength(node: BrainNode, degree: number, maxEdge: number): number {
  const dNorm = Math.min(1, Math.log2(1 + degree) / 3);
  const rNorm = Math.min(1, Math.log2(1 + (node.recallCount ?? 0)) / 5);
  return 0.5 * dNorm + 0.3 * maxEdge + 0.2 * rNorm;
}

export function scoreNovelty(
  graph: { nodes: BrainNode[]; edges: BrainEdge[] },
  taskText: string,
  options: NoveltyOptions = {},
): NoveltyResult {
  const { ladder, thresholds } =
    options.ladder && options.thresholds
      ? { ladder: options.ladder, thresholds: options.thresholds }
      : modelLadder();
  const opts = { ...NOVELTY_DEFAULTS, ...options };
  const done = (novelty: number, top: NoveltyContributor[]): NoveltyResult => ({
    novelty,
    model: pickModel(novelty, ladder, thresholds),
    ladder,
    thresholds,
    top,
  });

  // Nothing known, or nothing to judge → brand-new territory.
  const queryTokens = tokenize(taskText);
  if (graph.nodes.length === 0 || queryTokens.size === 0) return done(1, []);

  // One pass over the edges for per-node degree and strongest incident edge.
  const degree = new Map<string, number>();
  const maxEdge = new Map<string, number>();
  for (const e of graph.edges) {
    for (const end of [e.from, e.to]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      maxEdge.set(end, Math.max(maxEdge.get(end) ?? 0, e.strength));
    }
  }

  // SEED — same lexical ranking recall uses, but never bypassed.
  const seeds = graph.nodes
    .map((n) => ({ n, score: scoreNode(taskText, n, queryTokens) }))
    .filter((x) => x.score > opts.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k);
  if (seeds.length === 0) return done(1, []);

  const top: NoveltyContributor[] = seeds.map(({ n, score }) => ({
    id: n.id,
    title: n.title,
    score,
    degree: degree.get(n.id) ?? 0,
    strength: nodeStrength(n, degree.get(n.id) ?? 0, maxEdge.get(n.id) ?? 0),
  }));

  // Coverage: how solidly the best seed matches (lexical scores rarely pass
  // ~0.6, so 0.35 already means "this is genuinely about a known node").
  const coverage = clamp01(top[0].score / 0.35);
  // Relevance-weighted mean strength of the matched anchors.
  const scoreSum = top.reduce((s, t) => s + t.score, 0);
  const meanStrength = top.reduce((s, t) => s + t.score * t.strength, 0) / scoreSum;
  const familiarity = coverage * meanStrength;
  return done(clamp01(1 - familiarity), top);
}
