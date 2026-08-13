// Commit drained clip proposals into the brain.
//
// A separate path from `applyDelta` for the same reasons importApply is: this
// path stamps a sourceUrl, returns the clipId→nodeId map the extension's
// feedback loop needs, never silently drops overflow, and enforces the clip
// invariants (origin 'clip', never category 'core', never overwrite a node of
// another origin — /v1/retract deletes by origin, so a clip node must contain
// only clip content).

import { nodeDegree, removeNode, upsertEdge, upsertNode } from './brainGraph.js';
import { trigramSim } from './score.js';
import { resolveRoot } from './spine.js';
import { placeNode, slug, type BrainFile, type BrainNode } from './types.js';
import type { ClipRecord } from './clip.js';
import type { ClipDuplicate, ClipProposal } from './clipDistill.js';

/**
 * Own budget, separate from the 400-node agent cap (clips are exempt there).
 * Past it the least-recalled clips go. Raised 60→200 for the extension's
 * standalone mode, where the clip pool IS the whole brain (and a migrated
 * standalone brain must survive /v1/import intact). Unobservable for existing
 * paired brains: no reachable state exceeds 60 — the old cap enforced that.
 */
export const MAX_CLIP_NODES = 200;

const CLIP_SAME_PAGE_STRENGTH = 0.5;
const CLIP_SIMILARITY_MIN = 0.4;
const MAX_CLIP_SIMILARITY_EDGES = 2;
const CLIP_HUB_STRENGTH = 0.3;

export interface ApplyClipsOptions {
  now?: Date;
}

export interface ApplyClipsResult {
  created: string[];
  refined: string[];
  /** clipId → node ids minted/refined from it (duplicates map to the existing node). */
  byClip: Map<string, string[]>;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function firstUrlOf(clipIds: readonly string[], clipsById: ReadonlyMap<string, ClipRecord>): string | undefined {
  for (const id of clipIds) {
    const url = clipsById.get(id)?.url;
    if (url) return url;
  }
  return undefined;
}

/** A free id for a new clip node that never collides with another origin. */
function clipNodeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const withSuffix = `${base.slice(0, 55)}-clip`;
  if (!taken.has(withSuffix)) return withSuffix;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 55 - String(i).length)}-clip-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function applyClips(
  brain: BrainFile,
  proposals: readonly ClipProposal[],
  duplicates: readonly ClipDuplicate[],
  clipsById: ReadonlyMap<string, ClipRecord>,
  opts: ApplyClipsOptions = {},
): ApplyClipsResult {
  const now = opts.now ?? new Date();
  const result: ApplyClipsResult = { created: [], refined: [], byClip: new Map() };
  const mapClip = (clipId: string, nodeId: string) => {
    const list = result.byClip.get(clipId) ?? [];
    if (!list.includes(nodeId)) list.push(nodeId);
    result.byClip.set(clipId, list);
  };

  const taken = new Set(brain.nodes.map((n) => n.id));
  const mintedIds = new Set<string>();

  for (const p of proposals) {
    const base = slug(p.title);
    if (!base) continue;

    const existing = brain.nodes.find((n) => n.id === base);
    const isClipRefine = existing?.origin === 'clip';
    const id = isClipRefine ? base : clipNodeId(base, taken);
    const sourceUrl = firstUrlOf(p.clipIds, clipsById);

    const prior = isClipRefine ? existing : undefined;
    const node: BrainNode = {
      id,
      title: p.title.slice(0, 80),
      category: p.category,
      content: p.content.slice(0, 1200),
      // A refine keeps the node's place on the board; only new nodes get placed.
      ...(prior
        ? { color: prior.color, x: prior.x, y: prior.y, size: prior.size }
        : placeNode(p.category)),
      origin: 'clip',
      lastUpdated: now.toISOString(),
      recallCount: prior?.recallCount ?? 0,
      lastRecalledAt: prior?.lastRecalledAt,
      ...(sourceUrl ?? prior?.sourceUrl ? { sourceUrl: sourceUrl ?? prior?.sourceUrl } : {}),
    };
    upsertNode(brain, node);
    taken.add(id);
    mintedIds.add(id);
    if (prior) result.refined.push(id);
    else result.created.push(id);
    for (const clipId of p.clipIds) mapClip(clipId, id);
  }

  // Tier 1 — clips minted this run that came from the same site are related.
  const minted = brain.nodes.filter((n) => mintedIds.has(n.id));
  for (let a = 0; a < minted.length; a++) {
    for (let b = a + 1; b < minted.length; b++) {
      const ha = hostOf(minted[a].sourceUrl);
      if (ha && ha === hostOf(minted[b].sourceUrl)) {
        upsertEdge(brain, { from: minted[a].id, to: minted[b].id, strength: CLIP_SAME_PAGE_STRENGTH });
      }
    }
  }

  // Tier 2 — textual similarity to anything already in the graph.
  for (const node of minted) {
    const scored: Array<{ id: string; sim: number }> = [];
    for (const other of brain.nodes) {
      if (other.id === node.id || mintedIds.has(other.id)) continue;
      const sim = trigramSim(`${node.title} ${node.content}`, `${other.title} ${other.content}`);
      if (sim >= CLIP_SIMILARITY_MIN) scored.push({ id: other.id, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    for (const e of scored.slice(0, MAX_CLIP_SIMILARITY_EDGES)) {
      upsertEdge(brain, { from: node.id, to: e.id, strength: Number(e.sim.toFixed(2)) });
    }
  }

  // Tier 3 — anything still orphaned hangs off the hub (same rule as import).
  const hubId = resolveRoot(brain.nodes, brain.edges) ?? undefined;
  if (hubId && taken.has(hubId)) {
    for (const id of result.created) {
      if (id !== hubId && nodeDegree(brain, id) === 0) {
        upsertEdge(brain, { from: id, to: hubId, strength: CLIP_HUB_STRENGTH });
      }
    }
  }

  // Duplicates: the capture maps to the node it restates — the extension's
  // record gets a nodeId either way. Origin-gated so a poisoned "of" can never
  // attribute (and later retract) a non-clip node.
  for (const d of duplicates) {
    const target = brain.nodes.find((n) => n.id === d.of);
    if (target?.origin === 'clip') mapClip(d.clipId, target.id);
  }

  return result;
}

/**
 * The clip pool's own budget, mirroring pruneBrain's comparator. Clip nodes are
 * exempt from the 400 cap, so THIS is the only thing bounding them. Returns the
 * evicted ids so the drain can compact the clip-map ledger.
 */
export function pruneClips(brain: BrainFile, maxClipNodes = MAX_CLIP_NODES): string[] {
  const clips = brain.nodes.filter((n) => n.origin === 'clip');
  if (maxClipNodes <= 0 || clips.length <= maxClipNodes) return [];
  const victims = clips
    .sort((a, b) => {
      if ((a.recallCount ?? 0) !== (b.recallCount ?? 0)) return (a.recallCount ?? 0) - (b.recallCount ?? 0);
      const at = Date.parse(a.lastRecalledAt ?? a.lastUpdated) || 0;
      const bt = Date.parse(b.lastRecalledAt ?? b.lastUpdated) || 0;
      return at - bt;
    })
    .slice(0, clips.length - maxClipNodes);
  for (const v of victims) removeNode(brain, v.id);
  return victims.map((v) => v.id);
}
