// Commit reviewed import items into the brain.
//
// A separate path from `applyDelta` on purpose. applyDelta is built for one
// session's delta: it stamps a single sessionId across the whole batch, knows
// only 'seed'|'agent' origins, has nowhere to put confidence, and — worst for
// this use — SILENTLY drops everything past maxNewNodes. For a bulk import that
// reads as "the user ticked 30 boxes and got 3 nodes with no explanation", so
// here the overflow is reported instead.

import { nodeDegree, upsertEdge, upsertNode } from './store.js';
import { trigramSim } from './score.js';
import { resolveRoot } from './spine.js';
import { placeNode, type BrainFile, type BrainNode } from './types.js';
import type { PendingItem } from './importDedup.js';

/**
 * Forty sessions of real history is worth a few dozen durable facts. Much below
 * this and a first import under-delivers; much above and the canvas stops being
 * readable.
 */
export const DEFAULT_MAX_NEW_NODES = 60;

/** Two items from the same work session are genuinely related. */
const PROVENANCE_BASE = 0.35;
const PROVENANCE_STEP = 0.15;
const PROVENANCE_MAX = 0.7;
/**
 * A 20-item session would otherwise emit a 190-edge clique and wreck the
 * layout, so each node keeps only its strongest few provenance links.
 */
const MAX_PROVENANCE_EDGES = 4;

const SIMILARITY_MIN = 0.4;
const MAX_SIMILARITY_EDGES = 2;
const HUB_STRENGTH = 0.3;

export interface ApplyImportOptions {
  hubId?: string;
  maxNewNodes?: number;
  now?: Date;
}

export interface ApplyImportResult {
  created: string[];
  refined: string[];
  skipped: Array<{ id: string; title: string; reason: 'cap' | 'invalid' }>;
  edges: number;
}

function sharedSessionCount(a: PendingItem, b: PendingItem): number {
  const ids = new Set(a.sources.map((s) => s.sessionId));
  let n = 0;
  for (const s of b.sources) if (ids.has(s.sessionId)) n += 1;
  return n;
}

export function applyImport(
  brain: BrainFile,
  items: readonly PendingItem[],
  opts: ApplyImportOptions = {},
): ApplyImportResult {
  const now = opts.now ?? new Date();
  const maxNew = opts.maxNewNodes ?? DEFAULT_MAX_NEW_NODES;
  const result: ApplyImportResult = { created: [], refined: [], skipped: [], edges: 0 };

  const existingIds = new Set(brain.nodes.map((n) => n.id));
  const written: PendingItem[] = [];
  let newCount = 0;

  for (const item of items) {
    const title = item.title.trim();
    const content = item.content.trim();
    if (!item.id || !title || !content) {
      result.skipped.push({ id: item.id, title, reason: 'invalid' });
      continue;
    }

    const existing = brain.nodes.find((n) => n.id === item.id);
    if (!existing) {
      if (newCount >= maxNew) {
        // Reported, never silently dropped — and it stays checked in the
        // preview, so a second --apply picks it up.
        result.skipped.push({ id: item.id, title, reason: 'cap' });
        continue;
      }
      newCount += 1;
    }

    const node: BrainNode = {
      id: item.id,
      title: title.slice(0, 80),
      category: item.category,
      content: content.slice(0, 1200),
      // A refine keeps the node's place on the board AND its origin: refining a
      // hand-curated seed must not demote it to an import.
      ...(existing
        ? { color: existing.color, x: existing.x, y: existing.y, size: existing.size, origin: existing.origin }
        : { ...placeNode(item.category), origin: 'import' as const }),
      sourceSession: item.sources[0]?.sessionId ?? existing?.sourceSession,
      importedFrom: item.sources.slice(0, 5).map((s) => s.sessionId),
      confidence: item.confidence,
      lastUpdated: now.toISOString(),
      recallCount: existing?.recallCount ?? 0,
      lastRecalledAt: existing?.lastRecalledAt,
      ...(existing?.graphifyRef ? { graphifyRef: existing.graphifyRef } : {}),
    };

    upsertNode(brain, node);
    written.push(item);
    if (existing) result.refined.push(item.id);
    else result.created.push(item.id);
    existingIds.add(item.id);
  }

  const before = brain.edges.length;

  // Tier 1 — provenance. Co-occurrence in one work session is the truest
  // relatedness signal available, and it is free.
  const byId = new Map(written.map((i) => [i.id, i]));
  for (const item of written) {
    const scored: Array<{ id: string; strength: number }> = [];
    for (const other of written) {
      if (other.id === item.id) continue;
      const shared = sharedSessionCount(item, other);
      if (shared < 1) continue;
      scored.push({
        id: other.id,
        strength: Math.min(PROVENANCE_MAX, PROVENANCE_BASE + PROVENANCE_STEP * (shared - 1)),
      });
    }
    scored.sort((a, b) => b.strength - a.strength);
    for (const e of scored.slice(0, MAX_PROVENANCE_EDGES)) {
      upsertEdge(brain, { from: item.id, to: e.id, strength: e.strength });
    }
  }

  // Tier 2 — textual similarity to anything already in the graph.
  for (const item of result.created) {
    const node = brain.nodes.find((n) => n.id === item);
    if (!node) continue;
    const scored: Array<{ id: string; sim: number }> = [];
    for (const other of brain.nodes) {
      if (other.id === node.id || byId.has(other.id)) continue;
      const sim = trigramSim(`${node.title} ${node.content}`, `${other.title} ${other.content}`);
      if (sim >= SIMILARITY_MIN) scored.push({ id: other.id, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    for (const e of scored.slice(0, MAX_SIMILARITY_EDGES)) {
      upsertEdge(brain, { from: node.id, to: e.id, strength: Number(e.sim.toFixed(2)) });
    }
  }

  // Tier 3 — anything still orphaned hangs off the hub, so the graph reads as
  // one structure rather than a scatter of islands (same rule as `init`).
  // resolveRoot, not `find(category === 'core')`: graphify imports its "god"
  // nodes as category 'core' too, so a real brain holds several and `find`
  // returns whichever happens to sit first in the array.
  const hubId = opts.hubId ?? resolveRoot(brain.nodes, brain.edges) ?? undefined;
  if (hubId && existingIds.has(hubId)) {
    for (const id of result.created) {
      if (id === hubId) continue;
      if (nodeDegree(brain, id) === 0) upsertEdge(brain, { from: id, to: hubId, strength: HUB_STRENGTH });
    }
  }

  result.edges = brain.edges.length - before;
  return result;
}
