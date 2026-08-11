// Graph consolidation, ported from the worker's brain/merge.ts and the
// brain_merge_reduce SQL. Two modes:
//
//   LLM-CONFIRMED DEDUP (runMergePass) — trigram shortlist of look-alike pairs,
//   an LLM confirms each pair is the SAME durable skill and authors the merged
//   text, then the loser folds into the survivor (edges repointed, max strength).
//
//   FOLD LEAST-USED (foldLeastUsed) — LLM-free "merge-not-prune": the least
//   recalled agent nodes fold into their nearest surviving neighbour (strongest
//   edge → most similar text → the hub). Knowledge is appended, never deleted.

import type { OneShot } from './claude.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import { trigramSim } from './score.js';
import { nodeDegree, upsertEdge } from './store.js';
import type { BrainFile, BrainNode } from './types.js';
import { extractJson } from './distill.js';

interface RawMerge {
  merge?: unknown;
  title?: unknown;
  content?: unknown;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

// Decide which node survives a merge. Returns null when the pair must NOT merge
// (two curated seed nodes, or a graphify import). Otherwise [survivor, loser].
export function chooseSurvivor(
  a: BrainNode,
  b: BrainNode,
  degree: Map<string, number>,
): [BrainNode, BrainNode] | null {
  // graphify nodes are replaced wholesale on re-ingest — anything folded into
  // (or out of) one would be silently lost, so they never take part in merges.
  if (a.origin === 'graphify' || b.origin === 'graphify') return null;
  const aSeed = a.origin === 'seed';
  const bSeed = b.origin === 'seed';
  if (aSeed && bSeed) return null; // never fold one curated node into another
  if (aSeed) return [a, b];
  if (bSeed) return [b, a];
  const da = degree.get(a.id) ?? 0;
  const db = degree.get(b.id) ?? 0;
  if (da !== db) return da > db ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

function buildMergePrompt(survivor: BrainNode, loser: BrainNode): string {
  return [
    `${NFF_PROMPT_MARKERS.curator} for a coding agent working on this project.`,
    `Two knowledge-graph nodes look like near-duplicates. Decide whether they capture`,
    `the SAME durable skill/playbook and, if so, write ONE merged node that keeps every`,
    `distinct, useful detail from both without repetition.`,
    ``,
    `Merge ONLY if they are truly the same skill. If they are merely related, overlap in`,
    `wording, or cover different procedures, DO NOT merge.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{"merge": true|false, "title": "<= 80 chars", "content": "<= 1200 chars, actionable"}`,
    `When "merge" is false, title/content may be empty.`,
    ``,
    `NODE A [${survivor.category}] ${survivor.title}`,
    survivor.content,
    ``,
    `NODE B [${loser.category}] ${loser.title}`,
    loser.content,
  ].join('\n');
}

/** Fold `loser` into `survivor`: rewrite text, repoint edges (max strength), delete loser. */
export function mergeNodes(
  brain: BrainFile,
  survivorId: string,
  loserId: string,
  title: string,
  content: string,
  now = new Date(),
): void {
  const survivor = brain.nodes.find((n) => n.id === survivorId);
  if (!survivor || survivorId === loserId) return;
  if (title) survivor.title = title.slice(0, 80);
  if (content) survivor.content = content.slice(0, 1200);
  survivor.lastUpdated = now.toISOString();

  // Repoint the loser's edges onto the survivor, keeping the strongest strength.
  const repointed = brain.edges
    .filter((e) => e.from === loserId || e.to === loserId)
    .map((e) => ({
      from: e.from === loserId ? survivorId : e.from,
      to: e.to === loserId ? survivorId : e.to,
      strength: e.strength,
    }))
    .filter((e) => e.from !== e.to);
  brain.edges = brain.edges.filter((e) => e.from !== loserId && e.to !== loserId);
  for (const e of repointed) {
    const existing = brain.edges.find(
      (x) => (x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from),
    );
    if (existing) existing.strength = Math.max(existing.strength, e.strength);
    else upsertEdge(brain, e);
  }
  brain.nodes = brain.nodes.filter((n) => n.id !== loserId);
}

export interface MergePassOptions {
  threshold?: number; // trigram gate for candidate pairs
  maxMerges?: number;
  candidateLimit?: number;
}

/** LLM-confirmed near-duplicate merge over the whole graph. Returns merges done. */
export async function runMergePass(
  brain: BrainFile,
  oneShot: OneShot,
  options: MergePassOptions = {},
): Promise<number> {
  const threshold = options.threshold ?? 0.55;
  const maxMerges = options.maxMerges ?? 2;
  const candidateLimit = options.candidateLimit ?? 8;
  if (maxMerges <= 0 || brain.nodes.length < 2) return 0;

  // Trigram shortlist over title+content — the local brain_merge_candidates.
  const scored: Array<{ a: string; b: string; sim: number }> = [];
  const seenPair = new Set<string>();
  for (let i = 0; i < brain.nodes.length; i++) {
    for (let j = i + 1; j < brain.nodes.length; j++) {
      const a = brain.nodes[i];
      const b = brain.nodes[j];
      const key = pairKey(a.id, b.id);
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const sim = trigramSim(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
      if (sim >= threshold) scored.push({ a: a.id, b: b.id, sim });
    }
  }
  scored.sort((x, y) => y.sim - x.sim);
  const pairs = scored.slice(0, candidateLimit);

  const consumed = new Set<string>();
  let merged = 0;
  for (const { a: idA, b: idB } of pairs) {
    if (merged >= maxMerges) break;
    if (consumed.has(idA) || consumed.has(idB)) continue;
    const a = brain.nodes.find((n) => n.id === idA);
    const b = brain.nodes.find((n) => n.id === idB);
    if (!a || !b) continue;

    const degree = new Map<string, number>([
      [idA, nodeDegree(brain, idA)],
      [idB, nodeDegree(brain, idB)],
    ]);
    const choice = chooseSurvivor(a, b, degree);
    if (!choice) continue; // two seed nodes — left untouched
    const [survivor, loser] = choice;

    try {
      const raw = await oneShot(buildMergePrompt(survivor, loser));
      const verdict = extractJson<RawMerge>(raw);
      if (!verdict || verdict.merge !== true) continue;
      const title = (typeof verdict.title === 'string' ? verdict.title.trim() : '').slice(0, 80);
      const content = (typeof verdict.content === 'string' ? verdict.content.trim() : '').slice(0, 1200);
      mergeNodes(brain, survivor.id, loser.id, title, content);
      consumed.add(loser.id);
      consumed.add(survivor.id);
      merged += 1;
    } catch {
      // best-effort, like the worker: a failed pair just skips
    }
  }
  return merged;
}

const MIN_KEEP = 8;

/**
 * LLM-free consolidation (the dashboard's ⤵ Merge / brain_merge_reduce):
 * fold ~`fraction` of the least-used agent nodes into their nearest surviving
 * neighbour. Content is appended, edges repointed — no knowledge is deleted.
 * Returns the number of nodes folded.
 */
export function foldLeastUsed(brain: BrainFile, fraction = 0.25, now = new Date()): number {
  const foldable = brain.nodes.filter(
    (n) => n.origin !== 'seed' && n.origin !== 'graphify' && n.category !== 'core',
  );
  const budget = Math.min(
    Math.floor(foldable.length * fraction),
    Math.max(0, brain.nodes.length - MIN_KEEP),
  );
  if (budget <= 0) return 0;

  const victims = [...foldable]
    .sort((a, b) => {
      if ((a.recallCount ?? 0) !== (b.recallCount ?? 0)) return (a.recallCount ?? 0) - (b.recallCount ?? 0);
      const at = Date.parse(a.lastRecalledAt ?? a.lastUpdated) || 0;
      const bt = Date.parse(b.lastRecalledAt ?? b.lastUpdated) || 0;
      return at - bt;
    })
    .slice(0, budget);
  const victimIds = new Set(victims.map((n) => n.id));

  let folded = 0;
  for (const victim of victims) {
    // graphify nodes may not absorb folded content either — it would vanish on re-ingest.
    const keepers = brain.nodes.filter(
      (n) => n.id !== victim.id && !victimIds.has(n.id) && n.origin !== 'graphify',
    );
    if (keepers.length === 0) break;

    // Survivor choice, three tiers like brain_merge_reduce:
    // 1) strongest-edge keeper neighbour (prefer seed, then strength)
    let survivor: BrainNode | undefined;
    const neighbourEdges = brain.edges
      .filter((e) => e.from === victim.id || e.to === victim.id)
      .map((e) => ({ other: e.from === victim.id ? e.to : e.from, strength: e.strength }))
      .filter((e) => !victimIds.has(e.other));
    neighbourEdges.sort((a, b) => b.strength - a.strength);
    for (const cand of neighbourEdges) {
      const n = keepers.find((k) => k.id === cand.other);
      if (n) {
        survivor = n;
        break;
      }
    }
    // 2) most textually-similar keeper
    if (!survivor) {
      let best = 0.1;
      for (const k of keepers) {
        const sim = trigramSim(`${victim.title} ${victim.content}`, `${k.title} ${k.content}`);
        if (sim > best) {
          best = sim;
          survivor = k;
        }
      }
    }
    // 3) the hub (category core, else most-connected keeper)
    if (!survivor) {
      survivor =
        keepers.find((k) => k.category === 'core') ??
        [...keepers].sort((a, b) => nodeDegree(brain, b.id) - nodeDegree(brain, a.id))[0];
    }
    if (!survivor) break;

    survivor.content = `${survivor.content}\n\n---\n${victim.content}`.slice(0, 1200);
    survivor.lastUpdated = now.toISOString();
    mergeNodes(brain, survivor.id, victim.id, '', '');
    victimIds.delete(victim.id); // it's gone now; keepers list stays consistent
    folded += 1;
  }
  return folded;
}
