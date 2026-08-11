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

export const DEFAULT_LADDER = ['sonnet', 'opus', 'fable'] as const;
export const DEFAULT_THRESHOLDS = [0.35, 0.7] as const;

/**
 * Below this many meaningful query tokens a prompt carries no opinion about the
 * model. "ok" tokenizes to nothing and "yes"/"continue" to a single token that
 * matches nothing — without this floor they score novelty 1 and demand the
 * frontier model, which is backwards: a continuation is the most FAMILIAR
 * moment in a session. Novelty 1 must mean "the brain looked and found
 * nothing", not "there was nothing to look with".
 */
export const MIN_SIGNAL_TOKENS = 2;

/** Dead band around each cut, so novelty wobbling at a boundary can't flap tiers. */
export const DEFAULT_HYSTERESIS = 0.05;

/** Consecutive below-band prompts required before giving up an expensive tier. */
export const DEFAULT_DOWNGRADE_STREAK = 2;

export interface NoveltyOptions {
  k?: number; // seed nodes considered
  minScore?: number; // lexical relevance floor
  ladder?: string[];
  thresholds?: number[];
  minSignalTokens?: number;
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
  signalTokens: number; // meaningful (non-stopword, 3+ char) query tokens
  hasSignal: boolean; // enough of them to have an opinion at all
}

const NOVELTY_DEFAULTS = { k: 6, minScore: 0.05, minSignalTokens: MIN_SIGNAL_TOKENS };

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

/**
 * Policy knobs from the environment, same silent-fallback stance as
 * modelLadder: a typo in an env var can never break a hook.
 */
export function policyOptions(env: Record<string, string | undefined> = process.env): {
  margin: number;
  downgradeStreak: number;
  minSignalTokens: number;
} {
  const num = (raw: string | undefined, fallback: number, ok: (n: number) => boolean): number => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && ok(n) ? n : fallback;
  };
  return {
    // A margin at/above 0.5 could invert the cuts — keep it a dead band, not a rewrite.
    margin: num(env.NFF_BRAIN_NOVELTY_HYSTERESIS, DEFAULT_HYSTERESIS, (n) => n >= 0 && n < 0.5),
    downgradeStreak: num(env.NFF_BRAIN_DOWNGRADE_STREAK, DEFAULT_DOWNGRADE_STREAK, (n) => Number.isInteger(n) && n >= 1),
    minSignalTokens: num(env.NFF_BRAIN_MIN_SIGNAL_TOKENS, MIN_SIGNAL_TOKENS, (n) => Number.isInteger(n) && n >= 0),
  };
}

/** First tier whose cut point the novelty stays under; past every cut → last (frontier). */
export function pickModel(novelty: number, ladder: string[], thresholds: number[]): string {
  for (let i = 0; i < thresholds.length; i++) {
    if (novelty < thresholds[i]) return ladder[i];
  }
  return ladder[ladder.length - 1];
}

/** What applyHysteresis needs to remember between prompts — see modelState.ts. */
export interface PrevTier {
  model: string;
  belowStreak: number;
}

export interface HysteresisOptions {
  margin?: number;
  downgradeStreak?: number;
}

/**
 * Damped tier selection. pickModel alone flaps: novelty wobbling either side of
 * a cut flips the tier on alternating prompts, and every flip types /model into
 * the user's terminal. So a move must clear the cut by `margin`, and a
 * DOWNGRADE must additionally hold for `downgradeStreak` prompts in a row —
 * abandoning an expensive model mid-task on one fluke prompt throws away the
 * context that model is already carrying.
 *
 * Upgrades jump straight to the tier novelty asks for rather than climbing one
 * rung per prompt: a genuinely novel task should reach the frontier at once.
 */
export function applyHysteresis(
  prev: PrevTier | null | undefined,
  novelty: number,
  ladder: string[],
  thresholds: number[],
  opts: HysteresisOptions = {},
): { model: string; belowStreak: number } {
  const margin = opts.margin ?? DEFAULT_HYSTERESIS;
  const downgradeStreak = Math.max(1, opts.downgradeStreak ?? DEFAULT_DOWNGRADE_STREAK);
  const raw = pickModel(novelty, ladder, thresholds);

  const prevIdx = prev ? ladder.indexOf(prev.model) : -1;
  // No history, or the ladder changed under us (env edit) — adopt the raw pick.
  if (prevIdx === -1) return { model: raw, belowStreak: 0 };

  const rawIdx = ladder.indexOf(raw);
  if (rawIdx === prevIdx) return { model: prev!.model, belowStreak: 0 };

  if (rawIdx > prevIdx) {
    // Upgrade: clear the cut just above the current tier by the full margin.
    const cut = thresholds[prevIdx];
    return novelty > cut + margin
      ? { model: raw, belowStreak: 0 }
      : { model: prev!.model, belowStreak: 0 };
  }

  // Downgrade: below the cut just under the current tier, for N prompts running.
  const cut = thresholds[prevIdx - 1];
  if (novelty >= cut - margin) return { model: prev!.model, belowStreak: 0 };
  const streak = (prev!.belowStreak ?? 0) + 1;
  return streak >= downgradeStreak
    ? { model: raw, belowStreak: 0 }
    : { model: prev!.model, belowStreak: streak };
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
  // Counted before any early return so callers can tell "found nothing" from
  // "had nothing to look with" — both score 1, only the first means novel.
  const queryTokens = tokenize(taskText);
  const signalTokens = queryTokens.size;
  const done = (novelty: number, top: NoveltyContributor[]): NoveltyResult => ({
    novelty,
    model: pickModel(novelty, ladder, thresholds),
    ladder,
    thresholds,
    top,
    signalTokens,
    hasSignal: signalTokens >= opts.minSignalTokens,
  });

  // Nothing known, or nothing to judge → brand-new territory.
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
