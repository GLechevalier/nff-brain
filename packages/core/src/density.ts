// Density-triggered clustering: once a brain has enough nodes that the graph
// reads as a hairball, group same-category nodes that are directly connected
// into one visual super-node. Same shape as spine.ts's grouping nodes — pure,
// deterministic, never persisted, recomputed every render — but a density
// cluster HIDES its members instead of drawing a boundary around them.
//
// "Semantic context similarity" here is category equality + direct edge
// adjacency, not embeddings — cheap, always available (every node already has
// a category), and legible (a cluster is "same kind of thing, actually
// linked" rather than a vector-space coincidence).
//
// Browser-safe: no `node:` imports, no dependencies (see
// packages/core/test/webviewImports.test.ts).

import { connectedComponents, type LayoutEdge } from './layout.js';

/** The fields density clustering needs — id/title/category, nothing more, so
 *  BrainNode, the webview's ViewNode, and the chrome sidepanel's GraphNode all
 *  satisfy it without adaptation. */
export interface DensityInputNode {
  id: string;
  title: string;
  category: string;
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
  /** Node count above which clustering kicks in at all. Below it this is a no-op. */
  threshold?: number;
  /** Minimum connected same-category group size worth collapsing into one node. */
  minClusterSize?: number;
}

export const DEFAULT_DENSITY_THRESHOLD = 55;
/** Starting default, not measured against a real brain yet — tune via opts if it over/under-groups. */
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

/**
 * Build density clusters for the current graph. Pure: `nodes` and `edges` are
 * never mutated, nothing is written to disk. Returns `[]` unless `nodes.length`
 * exceeds `threshold` — the feature is fully inert below the density line.
 */
export function buildDensityClusters(
  nodes: readonly DensityInputNode[],
  edges: readonly LayoutEdge[],
  opts: DensityOptions = {},
): DensityCluster[] {
  const threshold = opts.threshold ?? DEFAULT_DENSITY_THRESHOLD;
  const minClusterSize = Math.max(2, opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  if (nodes.length <= threshold) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sameCategoryEdges = edges.filter((e) => {
    if (e.from === e.to) return false;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    return !!a && !!b && a.category === b.category;
  });

  const groups = connectedComponents(nodes, sameCategoryEdges).filter((g) => g.length >= minClusterSize);

  // Deterministic output order: biggest first, then by lowest member id — same
  // tie-break discipline as spine.ts's agglomerate().
  const minId = (g: string[]): string => g.reduce((m, id) => (id < m ? id : m), g[0]);
  groups.sort((a, b) => b.length - a.length || (minId(a) < minId(b) ? -1 : minId(a) > minId(b) ? 1 : 0));

  let seq = 0;
  return groups.map((memberIds) => {
    const sorted = [...memberIds].sort();
    const category = byId.get(sorted[0])?.category ?? 'strategy';
    return {
      id: `${DENSITY_PREFIX}${category}-${seq++}`,
      category,
      memberIds: sorted,
      summary: summarise(sorted, byId),
      size: Math.min(48, 20 + Math.sqrt(sorted.length) * 4),
    };
  });
}
