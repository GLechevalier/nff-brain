// Hybrid ranking: lexical (score.ts) fused with semantic (vector.ts) by
// Reciprocal Rank Fusion. BROWSER-SAFE — imports only ./score.js and
// ./vector.js, never node:*. Bundled into the webview alongside score.ts.
//
// THE INVARIANT: fuseRanked(q, nodes, null) returns exactly rankNodes(q, nodes)'s
// order and score values. Every call site can therefore adopt fuseRanked
// unconditionally and pass a real semantic list later. rank.test.ts asserts it.
//
// WHY RRF AND NOT A WEIGHTED SUM: see the gotcha comment at the top of
// vector.ts. Embedding cosines have a compressed, high baseline (~0.6–0.7 for
// unrelated text), so they are not commensurable with scoreNode values and any
// weighted blend silently promotes non-matches. Rank fusion is scale-free and
// needs no per-model recalibration.
//
// The `fused` number is a NEW scale (~1/k). It must never be fed to novelty.ts
// or mergePass.ts, whose thresholds are calibrated against the frozen lexical
// scale — see the contract comment at the top of score.ts.

import { rankNodes } from './score.js';
import type { SimHit } from './vector.js';

export const DEFAULT_RRF_K = 60;
export const DEFAULT_RRF_WEIGHTS: readonly [number, number] = [1, 1];

/**
 * Absolute cosine below which a semantic candidate is never considered.
 *
 * MEASURED, not guessed — and it is specific to the model AND its query prefix.
 * Sampled over the 14-node dev brain with Xenova/bge-small-en-v1.5 and the bge
 * retrieval prefix, `nff-brain search --limit 8` with the floor disabled:
 *
 *   true positives        0.59 – 0.73   (6 paraphrase queries, no token overlap)
 *   plausible runners-up  0.52 – 0.55
 *   unrelated query       0.38 – 0.42   ("how do I bake sourdough bread")
 *
 * 0.55 admits every true positive and excludes the noise floor by a wide
 * margin. Do NOT copy a number from a blog post: absolute cosine scales differ
 * per model, per prefix, and somewhat per corpus. To re-tune after changing
 * NFF_BRAIN_EMBED_MODEL, repeat the measurement:
 *   NFF_BRAIN_SEMANTIC_FLOOR=0 nff-brain search "<paraphrase>" --limit 8
 * and put the floor between the worst true positive and the best noise hit.
 */
export const DEFAULT_SEMANTIC_FLOOR = 0.55;

/**
 * ...and a candidate must also be within this much of the best cosine seen.
 * This is the scale-free half of the gate: it trims tangential runners-up when
 * there IS a strong leader, and it is what stops a query with no real match
 * (where everything is bunched near the noise floor) from promoting whichever
 * node happened to come first.
 */
export const SEMANTIC_FLOOR_BAND = 0.1;

export interface HybridHit<T> {
  node: T;
  /** EXACTLY rankNodes' score, or 0 when the node is a semantic-only hit. */
  lexical: number;
  /** Raw cosine, or 0 when the node is a lexical-only hit. */
  semantic: number;
  /** RRF — a new scale. In the pure-lexical path this equals `lexical`. */
  fused: number;
}

export interface FuseOptions {
  limit?: number;
  /** Passed straight through to rankNodes (default 0.2 there). */
  minScore?: number;
  /** RRF constant. Larger = flatter, less top-heavy. */
  k?: number;
  /** [lexicalWeight, semanticWeight]. */
  weights?: readonly [number, number];
  /** Absolute cosine floor for semantic candidates. */
  floor?: number;
}

interface Identified {
  id: string;
  title: string;
  content: string;
}

/**
 * Rank nodes against a query, optionally fusing in semantic hits.
 *
 * `semantic` is a cosine-sorted list keyed by node id — pass null (or an empty
 * list) when embeddings are unavailable, and the result is pure lexical.
 */
export function fuseRanked<T extends Identified>(
  query: string,
  nodes: T[],
  semantic: SimHit[] | null,
  opts: FuseOptions = {},
): HybridHit<T>[] {
  if (!query.trim()) return [];
  // No limit here: rankNodes slices only after sorting, so slicing at the end
  // is equivalent — and fusion needs the full lexical ranking to assign ranks.
  const lex = rankNodes(query, nodes, { minScore: opts.minScore });

  if (!semantic || semantic.length === 0) {
    const out = lex.map((r) => ({ node: r.node, lexical: r.score, semantic: 0, fused: r.score }));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  const limit = opts.limit ?? nodes.length;
  const k = opts.k ?? DEFAULT_RRF_K;
  const [wLex, wSem] = opts.weights ?? DEFAULT_RRF_WEIGHTS;

  // Defensive: don't assume the caller sorted, and drop weak candidates so a
  // query with no real match can't drag arbitrary nodes in on rank alone.
  const sorted = [...semantic].sort((a, b) => b.sim - a.sim);
  const top = sorted[0]?.sim ?? 0;
  const floor = Math.max(opts.floor ?? DEFAULT_SEMANTIC_FLOOR, top - SEMANTIC_FLOOR_BAND);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sem = sorted.filter((h) => h.sim >= floor && byId.has(h.id)).slice(0, limit * 3);

  const lexRank = new Map<string, number>();
  lex.forEach((r, i) => lexRank.set(r.node.id, i + 1));
  const semRank = new Map<string, number>();
  sem.forEach((h, i) => semRank.set(h.id, i + 1));
  const semSim = new Map(sem.map((h) => [h.id, h.sim]));
  const lexScore = new Map(lex.map((r) => [r.node.id, r.score]));

  const ids = new Set<string>([...lexRank.keys(), ...semRank.keys()]);
  const out: HybridHit<T>[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const rl = lexRank.get(id);
    const rs = semRank.get(id);
    out.push({
      node,
      lexical: lexScore.get(id) ?? 0,
      semantic: semSim.get(id) ?? 0,
      fused: (rl ? wLex / (k + rl) : 0) + (rs ? wSem / (k + rs) : 0),
    });
  }
  // Deterministic ordering: fused, then lexical, then semantic, then id.
  out.sort(
    (a, b) =>
      b.fused - a.fused ||
      b.lexical - a.lexical ||
      b.semantic - a.semantic ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  );
  return opts.limit ? out.slice(0, opts.limit) : out;
}
