// Restructuring: improve the graph's REAL edge structure, so the derived spine
// has less scaffolding to invent.
//
// The spine can link any set of islands into a tree, but a tree over 30 islands
// is mostly invented structure. The way to get a naturally better tree is to
// have fewer, larger, genuinely-connected islands — which means creating the
// edges that should already exist.
//
// And a specific set of them should: importApply's Tier 2 links a node to
// anything it is trigram-similar to (>= SIMILARITY_MIN, capped per node), but
// it only ever runs on nodes AT THE MOMENT THEY ARE CREATED, comparing against
// whatever the brain held then. It never runs backwards. A node imported in
// March is never compared against one distilled in August. This module is that
// pass, run globally — a backfill, not a new policy.
//
// Browser-safe (no `node:` imports) and pure: it returns a PLAN and writes
// nothing. The caller decides whether to apply it.

import { connectedComponents, type LayoutEdge } from './layout.js';
import { DEFAULT_SEMANTIC_FLOOR } from './rank.js';
import { trigramSim } from './score.js';
import { cosine } from './vector.js';

export interface RestructureNode {
  id: string;
  title: string;
  content: string;
}

export interface EdgeCandidate {
  from: string;
  to: string;
  /** 0..1 similarity that justified this link. Becomes the edge strength. */
  sim: number;
  /** Which signal proposed it — the two scales are NOT comparable. */
  via: 'trigram' | 'semantic';
}

export interface CurvePoint {
  floor: number;
  edges: number;
  islands: number;
  largest: number;
  singletons: number;
}

export interface RestructurePlan {
  candidates: EdgeCandidate[];
  islandsBefore: number;
  islandsAfter: number;
  largestBefore: number;
  largestAfter: number;
  singletonsBefore: number;
  singletonsAfter: number;
  /** How the outcome varies with the floor, so the floor can be CHOSEN, not assumed. */
  curve: CurvePoint[];
  semanticUsed: boolean;
}

/**
 * The same floor importApply's Tier 2 already uses (SIMILARITY_MIN). Keeping it
 * means this command asserts nothing new — it only completes work the codebase
 * already intends to do.
 */
export const DEFAULT_FLOOR = 0.4;
/** Matches MAX_SIMILARITY_EDGES: no node may become a hub by accident. */
export const DEFAULT_CAP = 2;
/**
 * Floor for EMBEDDING cosine, which is a different scale from trigram Dice and
 * must never share its threshold.
 *
 * Reuses rank.ts's floor rather than inventing a second number — but note that
 * one was measured for QUERY→node relevance, and this is node→node
 * relatedness. ⚠ Re-measure before trusting it here: the preview reports how
 * many links came in via the semantic path, which is the signal to watch.
 */
export const RELATEDNESS_SEMANTIC_FLOOR = DEFAULT_SEMANTIC_FLOOR;

const CURVE_FLOORS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25];

export interface RestructureOptions {
  floor?: number;
  cap?: number;
  /** Node vectors, when the semantic runtime has indexed this brain. */
  vectors?: Map<string, Float32Array> | null;
  semanticFloor?: number;
  curveFloors?: readonly number[];
}

interface Scored {
  from: string;
  to: string;
  sim: number;
  via: 'trigram' | 'semantic';
}

function componentStats(
  nodes: readonly RestructureNode[],
  edges: readonly LayoutEdge[],
): { count: number; largest: number; singletons: number; indexById: Map<string, number> } {
  const comps = connectedComponents(nodes, edges);
  const indexById = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((id) => indexById.set(id, i)));
  return {
    count: comps.length,
    largest: comps.length ? Math.max(...comps.map((c) => c.length)) : 0,
    singletons: comps.filter((c) => c.length === 1).length,
    indexById,
  };
}

/**
 * Greedily take the strongest candidates, refusing any that would push a node
 * past `cap`. Deterministic: sorted by similarity, then by id pair.
 */
function applyCap(scored: readonly Scored[], cap: number): Scored[] {
  const used = new Map<string, number>();
  const out: Scored[] = [];
  const sorted = [...scored].sort(
    (a, b) => b.sim - a.sim || (a.from + a.to < b.from + b.to ? -1 : 1),
  );
  for (const s of sorted) {
    if ((used.get(s.from) ?? 0) >= cap || (used.get(s.to) ?? 0) >= cap) continue;
    used.set(s.from, (used.get(s.from) ?? 0) + 1);
    used.set(s.to, (used.get(s.to) ?? 0) + 1);
    out.push(s);
  }
  return out;
}

/**
 * Plan a restructure. Pure — nothing is written.
 *
 * Only CROSS-island pairs are considered: a link inside an island changes no
 * structure, and the point here is to reduce the island count. Candidates are
 * scored against the ORIGINAL partition, so the result does not depend on the
 * order links happen to be applied in.
 */
export function planRestructure(
  nodes: readonly RestructureNode[],
  edges: readonly LayoutEdge[],
  opts: RestructureOptions = {},
): RestructurePlan {
  const floor = opts.floor ?? DEFAULT_FLOOR;
  const cap = Math.max(1, opts.cap ?? DEFAULT_CAP);
  const semanticFloor = opts.semanticFloor ?? RELATEDNESS_SEMANTIC_FLOOR;
  const vectors = opts.vectors ?? null;

  const before = componentStats(nodes, edges);
  const existing = new Set(edges.map((e) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`)));

  // Score every cross-island pair once.
  const scored: Scored[] = [];
  let semanticUsed = false;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (before.indexById.get(a.id) === before.indexById.get(b.id)) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (existing.has(key)) continue;

      const t = trigramSim(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
      scored.push({ from: a.id, to: b.id, sim: t, via: 'trigram' });

      // Embeddings are a SEPARATE signal on a different scale — never blended
      // into the trigram number, only offered alongside it under its own floor.
      const va = vectors?.get(a.id);
      const vb = vectors?.get(b.id);
      if (va && vb) {
        semanticUsed = true;
        const c = cosine(va, vb);
        if (c >= semanticFloor && t < floor) {
          scored.push({ from: a.id, to: b.id, sim: c, via: 'semantic' });
        }
      }
    }
  }

  const chosen = applyCap(
    scored.filter((s) => (s.via === 'semantic' ? s.sim >= semanticFloor : s.sim >= floor)),
    cap,
  );
  const asEdges = (list: readonly Scored[]): LayoutEdge[] =>
    list.map((s) => ({ from: s.from, to: s.to, strength: Number(s.sim.toFixed(2)) }));

  const after = componentStats(nodes, [...edges, ...asEdges(chosen)]);

  // The curve: what each floor would do. This is what makes the threshold a
  // measured choice instead of a guess — there is a cliff, and it is visible here.
  const curve: CurvePoint[] = [];
  for (const f of opts.curveFloors ?? CURVE_FLOORS) {
    const picked = applyCap(
      scored.filter((s) => s.via === 'trigram' && s.sim >= f),
      cap,
    );
    const st = componentStats(nodes, [...edges, ...asEdges(picked)]);
    curve.push({
      floor: f,
      edges: picked.length,
      islands: st.count,
      largest: st.largest,
      singletons: st.singletons,
    });
  }

  return {
    candidates: chosen.map((s) => ({
      from: s.from,
      to: s.to,
      sim: Number(s.sim.toFixed(3)),
      via: s.via,
    })),
    islandsBefore: before.count,
    islandsAfter: after.count,
    largestBefore: before.largest,
    largestAfter: after.largest,
    singletonsBefore: before.singletons,
    singletonsAfter: after.singletons,
    curve,
    semanticUsed,
  };
}
