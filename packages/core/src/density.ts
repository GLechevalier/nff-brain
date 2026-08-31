// Density-triggered clustering: where a brain's graph is actually crowded on
// screen, group same-category nodes into one visual super-node. Same shape as
// spine.ts's grouping nodes — pure, deterministic, never persisted, recomputed
// every render — but a density cluster HIDES its members instead of drawing a
// boundary around them.
//
// Two-stage, matching the two things the name "density" was doing double duty
// for: SEMANTIC similarity (same category, linked by a real edge) narrows the
// candidate pool; SPATIAL density (members actually packed close together on
// the board, not just graph-connected) decides which part of that pool is
// worth collapsing. A same-category chain that the layout has spread across
// the whole board is graph-connected but not dense, and must not collapse —
// collapsing it would hide structure the reader can already read clearly.
//
// The radius is expressed as a multiple of the pair's own size, not a fixed
// board-unit or pixel number: node.x/y/size live in whatever coordinate space
// the caller's layout uses (vscode's layoutBrain spans a few thousand units;
// nff-admin's spaceOutNodes and the chrome sidepanel's on-disk positions use
// a different scale again), and a constant radius tuned for one would be
// meaningless in another. Self-scaling by size is the one thing every caller
// already agrees on.
//
// Browser-safe: no `node:` imports, no dependencies (see
// packages/core/test/webviewImports.test.ts).

import { connectedComponents, type LayoutEdge } from './layout.js';

/** The fields density clustering needs. BrainNode, the webview's ViewNode, and
 *  the chrome sidepanel's GraphNode all satisfy it without adaptation — every
 *  one of them already carries x/y/size for rendering. */
export interface DensityInputNode {
  id: string;
  title: string;
  category: string;
  x: number;
  y: number;
  size: number;
}

/** A virtual super-node standing in for a group of real nodes. Never persisted. */
export interface DensityCluster {
  id: string; // always `density:…` — mirrors spine's `spine:` prefix, can't collide with a real node id
  category: string;
  memberIds: string[];
  /** Extractive, not generated: count + a few member titles. Same philosophy as spine's summarise(). */
  summary: string;
  size: number;
}

export interface DensityOptions {
  /**
   * Two members count as spatially "crowded" when their distance is within
   * this many times their combined size. Starting default, not measured
   * against a real brain yet — same honesty spine.ts's DEFAULT_MIN_SIM
   * carries: tune via opts if it over- or under-groups on real data.
   */
  radiusFactor?: number;
  /** Minimum spatially-crowded same-category group worth collapsing into one node. */
  minClusterSize?: number;
}

export const DEFAULT_RADIUS_FACTOR = 3;
export const DEFAULT_MIN_CLUSTER_SIZE = 4;

const DENSITY_PREFIX = 'density:';

export function isDensityClusterId(id: string): boolean {
  return id.startsWith(DENSITY_PREFIX);
}

function summarise(memberIds: readonly string[], byId: Map<string, DensityInputNode>, maxTitles = 4): string {
  const titles = memberIds
    .map((id) => byId.get(id)?.title ?? id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = titles.slice(0, maxTitles);
  const rest = titles.length - shown.length;
  const list = shown.length ? ` — ${shown.join('; ')}${rest > 0 ? `; +${rest} more` : ''}` : '';
  return `${memberIds.length} nodes${list}`;
}

/** Spatial adjacency within one semantic group: an edge between every pair
 *  crowded enough to count as touching. O(n²) on the GROUP, not the graph —
 *  groups are the narrow slice connectedComponents already produced. */
function spatialEdgesFor(members: readonly DensityInputNode[], radiusFactor: number): LayoutEdge[] {
  const out: LayoutEdge[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const r = radiusFactor * (a.size + b.size);
      if (dx * dx + dy * dy <= r * r) out.push({ from: a.id, to: b.id, strength: 1 });
    }
  }
  return out;
}

/**
 * Build density clusters for the current graph. Pure: `nodes` and `edges` are
 * never mutated, nothing is written to disk. A same-category graph-connected
 * group that isn't actually crowded together on the board never appears here.
 */
export function buildDensityClusters(
  nodes: readonly DensityInputNode[],
  edges: readonly LayoutEdge[],
  opts: DensityOptions = {},
): DensityCluster[] {
  const radiusFactor = opts.radiusFactor ?? DEFAULT_RADIUS_FACTOR;
  const minClusterSize = Math.max(2, opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Stage 1 — semantic similarity: same category, linked by a real edge.
  // Narrows the graph down to candidate pools; not yet a decision to collapse.
  const sameCategoryEdges = edges.filter((e) => {
    if (e.from === e.to) return false;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    return !!a && !!b && a.category === b.category;
  });
  const semanticGroups = connectedComponents(nodes, sameCategoryEdges).filter((g) => g.length >= minClusterSize);

  // Stage 2 — spatial density: within each candidate pool, only the part
  // that's actually packed together on the board collapses. A pool can split
  // into several dense pockets, or none.
  const found: Array<{ memberIds: string[]; category: string }> = [];
  for (const groupIds of semanticGroups) {
    const members = groupIds.map((id) => byId.get(id)!);
    const denseSubgroups = connectedComponents(members, spatialEdgesFor(members, radiusFactor)).filter(
      (g) => g.length >= minClusterSize,
    );
    for (const sub of denseSubgroups) {
      const sorted = [...sub].sort();
      found.push({ memberIds: sorted, category: byId.get(sorted[0])!.category });
    }
  }

  // Deterministic output order: biggest first, then by lowest member id — same
  // tie-break discipline as spine.ts's agglomerate().
  found.sort(
    (a, b) =>
      b.memberIds.length - a.memberIds.length ||
      (a.memberIds[0] < b.memberIds[0] ? -1 : a.memberIds[0] > b.memberIds[0] ? 1 : 0),
  );

  let seq = 0;
  return found.map(({ memberIds, category }) => ({
    id: `${DENSITY_PREFIX}${category}-${seq++}`,
    category,
    memberIds,
    summary: summarise(memberIds, byId),
    size: Math.min(48, 20 + Math.sqrt(memberIds.length) * 4),
  }));
}
