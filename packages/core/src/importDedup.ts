// Cross-session dedup for `nff-brain import`.
//
// Forty sessions of real history propose the same lesson over and over — the
// Windows rename retry, the "restart doesn't fix DNS" gotcha, the house style.
// Two jobs here, both LLM-free so they cost nothing and are fully testable:
//
//   1. CLUSTER identical-in-substance proposals into one, and use the cluster
//      SIZE as evidence: a lesson that surfaced in five separate sessions is
//      far more durable than one that surfaced once. That is the single best
//      confidence signal in the whole feature, and it only exists in bulk —
//      the per-session distiller can never see it.
//   2. RECONCILE against what the brain already knows, so an import refines
//      rather than duplicates, and never re-offers something the user has
//      already seen and rejected.

import { uniqueId } from './ingestGraphify.js';
import { trigramSim } from './score.js';
import { slug, type BrainFile, type BrainNode, type Category } from './types.js';
import type { ImportKind, Proposal, SessionRef } from './importExtract.js';

/** Same gate as runMergePass — two texts this close say the same thing. */
export const CLUSTER_THRESHOLD = 0.55;
/** Above this against an existing node, it is not new knowledge at all. */
export const DUPLICATE_THRESHOLD = 0.72;

function pairSim(aTitle: string, aBody: string, bTitle: string, bBody: string): number {
  // Titles carry the claim, bodies carry the detail — weight accordingly.
  return 0.6 * trigramSim(aTitle, bTitle) + 0.4 * trigramSim(aBody, bBody);
}

/**
 * Confidence given `n` independent sessions proposed the same thing.
 *
 * Saturating and monotonic: each extra session closes 30% of the remaining gap
 * to certainty, so a 0.5 lesson reads 0.65 at two sessions, 0.76 at three and
 * 0.88 at five, and nothing can ever exceed 1. Repetition strengthens belief
 * without ever manufacturing it — a lesson nobody was sure of stays uncertain
 * no matter how often it recurs.
 */
export const BOOST_DECAY = 0.7;

export function boostForSources(headConfidence: number, sources: number): number {
  const n = Math.max(1, sources);
  const boosted = 1 - (1 - headConfidence) * Math.pow(BOOST_DECAY, n - 1);
  return Math.min(1, Number(boosted.toFixed(4)));
}

function mergeSources(a: SessionRef[], b: SessionRef[]): SessionRef[] {
  const seen = new Set(a.map((s) => s.sessionId));
  const out = [...a];
  for (const s of b) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    out.push(s);
  }
  return out;
}

export interface ClusterOptions {
  threshold?: number;
}

/**
 * Fold near-identical proposals together. Highest-confidence proposal heads its
 * cluster (so the best-written phrasing is the one kept) and cluster size then
 * boosts the confidence.
 *
 * Kinds never cross: a `task` and a `decision` about the same subsystem are
 * different knowledge even when their wording is close.
 */
export function clusterProposals(proposals: readonly Proposal[], opts: ClusterOptions = {}): Proposal[] {
  const threshold = opts.threshold ?? CLUSTER_THRESHOLD;
  const byConfidence = [...proposals].sort((a, b) => b.confidence - a.confidence);
  const clusters: Proposal[] = [];

  for (const p of byConfidence) {
    let best: Proposal | null = null;
    let bestSim = 0;
    for (const c of clusters) {
      if (c.kind !== p.kind) continue;
      const sim = pairSim(p.title, p.content, c.title, c.content);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= threshold) {
      best.sources = mergeSources(best.sources, p.sources);
      // The head keeps its title, but a terse head yields to a fuller body.
      if (best.content.length < 200 && p.content.length > best.content.length) {
        best.content = p.content;
      }
      continue;
    }
    clusters.push({ ...p, sources: [...p.sources] });
  }

  for (const c of clusters) {
    c.confidence = boostForSources(c.confidence, c.sources.length);
  }
  return clusters.sort((a, b) => b.confidence - a.confidence);
}

export type PendingStatus = 'new' | 'refine' | 'duplicate';

export interface PendingItem {
  key: string; // short stable marker printed in the preview, e.g. "d1"
  id: string; // node id this will write to
  targetId?: string; // the existing node, when refining or duplicating
  status: PendingStatus;
  kind: ImportKind;
  category: Category;
  title: string;
  content: string;
  confidence: number;
  checked: boolean;
  sources: SessionRef[];
  previousContent?: string; // shown as "was:" for a refine
  hash: string; // ledger key — survives the node being deleted
}

/**
 * Ledger key for a proposal. Deliberately content-INDEPENDENT (kind + title
 * only): the point is to recognise "you have offered me this before" even when
 * the wording drifts between runs.
 */
export function proposalHash(kind: ImportKind, title: string): string {
  return `${kind}:${slug(title)}`;
}

export interface ReconcileOptions {
  minConfidence: number;
  seenHashes?: ReadonlySet<string>;
  duplicateThreshold?: number;
  clusterThreshold?: number;
}

const KEY_PREFIX: Record<ImportKind, string> = {
  memory: 'm',
  decision: 'd',
  preference: 'p',
  task: 't',
  failure: 'f',
};

/**
 * Decide what each cluster means against the current brain: brand new, a
 * refinement of a node we have, or something we already know.
 */
export function reconcileWithBrain(
  brain: BrainFile,
  clusters: readonly Proposal[],
  opts: ReconcileOptions,
): PendingItem[] {
  const dupThreshold = opts.duplicateThreshold ?? DUPLICATE_THRESHOLD;
  const refineThreshold = opts.clusterThreshold ?? CLUSTER_THRESHOLD;
  const seen = opts.seenHashes ?? new Set<string>();

  // graphify/supabase nodes are replaced wholesale on re-ingest, so refining one
  // would silently lose the edit at the next ingest. Clip nodes must stay pure
  // clip content (retraction deletes by origin), so imports may not refine them
  // either.
  const pool: BrainNode[] = brain.nodes.filter(
    (n) => n.origin !== 'graphify' && n.origin !== 'supabase' && n.origin !== 'clip',
  );
  const byId = new Map(pool.map((n) => [n.id, n]));
  const taken = new Set(brain.nodes.map((n) => n.id));
  const counters: Record<string, number> = {};
  const out: PendingItem[] = [];

  for (const c of clusters) {
    const hash = proposalHash(c.kind, c.title);
    if (seen.has(hash)) continue; // offered before — do not nag

    const prefix = KEY_PREFIX[c.kind];
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const key = `${prefix}${counters[prefix]}`;
    const baseId = slug(c.title);

    let status: PendingStatus = 'new';
    let targetId: string | undefined;
    let previousContent: string | undefined;

    const exact = baseId ? byId.get(baseId) : undefined;
    if (exact) {
      status = 'refine';
      targetId = exact.id;
      previousContent = exact.content;
    } else {
      let best: BrainNode | null = null;
      let bestSim = 0;
      for (const n of pool) {
        const sim = pairSim(c.title, c.content, n.title, n.content);
        if (sim > bestSim) {
          bestSim = sim;
          best = n;
        }
      }
      if (best && bestSim >= dupThreshold) {
        status = 'duplicate';
        targetId = best.id;
        previousContent = best.content;
      } else if (best && bestSim >= refineThreshold) {
        status = 'refine';
        targetId = best.id;
        previousContent = best.content;
      }
    }

    const id = targetId ?? uniqueId(baseId || slug(c.kind), taken, c.kind);

    out.push({
      key,
      id,
      targetId,
      status,
      kind: c.kind,
      category: c.category,
      title: c.title,
      content: c.content,
      confidence: c.confidence,
      // A duplicate starts unchecked however confident it is — by definition
      // the brain already has it, so the default should be "don't bother".
      checked: status !== 'duplicate' && c.confidence >= opts.minConfidence,
      sources: c.sources,
      previousContent,
      hash,
    });
  }

  return out;
}
