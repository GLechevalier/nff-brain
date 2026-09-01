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
// The spatial half is DELIBERATELY the same metric as nff-admin's "▦ Density"
// heatmap toggle (count of other nodes within a radius): `radius` is passed
// in by the caller, already resolved from DEFAULT_DENSITY_SCREEN_RADIUS
// divided by that renderer's current zoom scale, exactly like the heatmap's
// own blob radius. Two "density" features showing two different definitions
// in the same app would be worse than either alone — this module owns the
// one shared constant so the heatmap and the cluster trigger can never drift
// apart. Board units differ across renderers (vscode's layoutBrain, nff-
// admin's spaceOutNodes, the chrome sidepanel's on-disk positions all use
// different scales), which is exactly why the radius arrives pre-resolved
// rather than as a size-relative multiplier: only the caller knows its own
// zoom.
//
// Browser-safe: no `node:` imports, no dependencies (see
// packages/core/test/webviewImports.test.ts).

import { connectedComponents, type LayoutEdge } from './layout.js';

/** The fields density clustering needs. BrainNode, the webview's ViewNode, and
 *  the chrome sidepanel's GraphNode all satisfy it without adaptation — every
 *  one of them already carries x/y for rendering. */
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
  /**
   * Id of the nearest `category: 'core'` node within `radius` of this
   * cluster's centroid, or null. A renderer uses this to draw the cluster in
   * that node's shape/size class instead of the generic cluster square — it
   * landed next to the hub, so it should read as belonging to it rather than
   * as an unrelated blob overlapping it. Same `radius` as the clustering
   * decision itself: "very close" is one definition, not a second number.
   */
  nearBigNodeId: string | null;
}

export interface DensityOptions {
  /**
   * Board-space radius within which two members count as "crowded" — the
   * same number nff-admin's density-heatmap blobs use, in the SAME units:
   * a caller with a zoomable view should pass
   * `DEFAULT_DENSITY_SCREEN_RADIUS / currentZoomScale`, exactly like the
   * heatmap's own `DENSITY_BLOB_SCREEN_RADIUS / view.scale`.
   */
  radius?: number;
  /** Minimum spatially-crowded same-category group worth collapsing into one node. */
  minClusterSize?: number;
}

/**
 * Screen-pixel radius the heatmap toggle and this module both resolve
 * against the current zoom. THE shared constant — change it here and both
 * features move together instead of drifting apart.
 */
export const DEFAULT_DENSITY_SCREEN_RADIUS = 90;
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
 *  within `radius` of each other — the identical test the heatmap runs per
 *  node, just also used to CHAIN nearby members into one blob. O(n²) on the
 *  GROUP, not the graph — groups are the narrow slice connectedComponents
 *  already produced. */
function spatialEdgesFor(members: readonly DensityInputNode[], radius: number): LayoutEdge[] {
  const out: LayoutEdge[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy <= radius * radius) out.push({ from: a.id, to: b.id, strength: 1 });
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
  const radius = opts.radius ?? DEFAULT_DENSITY_SCREEN_RADIUS;
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
    const denseSubgroups = connectedComponents(members, spatialEdgesFor(members, radius)).filter(
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

  // Core nodes to test cluster centroids against for the "landed next to the
  // hub" shape-inheritance signal below. Rare in practice (a handful of hub /
  // tab-master nodes), so a per-cluster linear scan is cheap.
  const coreNodes = nodes.filter((n) => n.category === 'core');

  let seq = 0;
  return found.map(({ memberIds, category }) => {
    const members = memberIds.map((id) => byId.get(id)!);
    const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
    const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
    let nearBigNodeId: string | null = null;
    let nearestDistSq = radius * radius;
    for (const core of coreNodes) {
      const dx = core.x - cx;
      const dy = core.y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= nearestDistSq) {
        nearestDistSq = distSq;
        nearBigNodeId = core.id;
      }
    }
    return {
      id: `${DENSITY_PREFIX}${category}-${seq++}`,
      category,
      memberIds,
      summary: summarise(memberIds, byId),
      size: Math.min(48, 20 + Math.sqrt(memberIds.length) * 4),
      nearBigNodeId,
    };
  });
}
