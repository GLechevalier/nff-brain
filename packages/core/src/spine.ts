// The navigational spine: a derived tree that connects every island of the
// graph to one guaranteed root.
//
// The force layout made the real structure visible, and what it showed was ~30
// disconnected islands — honest, but impossible to navigate. The spine adds the
// missing links WITHOUT inventing knowledge: it is recomputed from the graph
// every time it is drawn and is never written to brain.json.
//
// That "never written" is load-bearing. A persisted grouping node would be
// injected into every session's context by recall (recall.ts injects the whole
// graph when it is ≤40 nodes), would sit at the front of foldLeastUsed's
// eviction queue (it sorts by recallCount ascending, and a fresh node has 0),
// would be offered to the merge pass as a near-duplicate of its siblings, and
// would have its edges rebuilt from a markdown link list on every save of its
// document. Deriving sidesteps all four.
//
// Browser-safe: no `node:` imports, no dependencies (the webview bundles this).
// Deterministic: no Math.random, every tie broken on sorted ids.

import { connectedComponents, type LayoutEdge } from './layout.js';
import { tokenize } from './score.js';

/** The fields the spine needs. BrainNode and the webview's ViewNode both satisfy it. */
export interface SpineInputNode {
  id: string;
  title: string;
  content: string;
  category: string;
  origin?: string;
}

/** A virtual grouping node. Never persisted, never a BrainNode. */
export interface SpineNode {
  id: string; // always `spine:…` — slug() cannot produce a colon, so it can never collide
  title: string;
  /** 1 = directly under the root, 2 = under a level-1 group, … */
  level: number;
  /** Real node ids in this subtree, for wedge weighting and click-to-highlight. */
  memberIds: string[];
  /**
   * What is actually under this node, in prose. Extractive, not generated: the
   * counts, the dominant categories and the islands' own titles. A grouping
   * node has no knowledge of its own, so anything beyond a description of its
   * children would be invention.
   */
  summary: string;
  size: number;
  /**
   * Mean pairwise similarity of the islands under this node, 0..1. Below
   * `minSim` the group is a grab-bag rather than a topic and is titled "misc" —
   * an honest label beats three keywords that only look like a theme.
   */
  cohesion: number;
}

export interface SpineResult {
  rootId: string | null;
  nodes: SpineNode[];
  edges: LayoutEdge[];
  /** Islands that were linked in. The root's own component is not one of them. */
  islandCount: number;
}

export interface SpineOptions {
  /** Max children before a level of grouping nodes is inserted. */
  fanout?: number;
  /** Override the resolved root. */
  rootId?: string;
  /**
   * Cosine floor below which two islands are NOT considered the same topic.
   * MEASURE this on a real brain — `nff-brain spine --dry-run` prints the
   * distribution. Assuming a floor is how the semantic-search cosine cutoff
   * ended up wrong once already.
   */
  minSim?: number;
}

export const DEFAULT_FANOUT = 7;
/**
 * Cohesion below which a group is called "misc" instead of being given keywords.
 *
 * MEASURED, not assumed — `nff-brain spine --dry-run` on a 94-node brain gave an
 * all-pairs island similarity of p50 0.089 / p90 0.240, and the resulting groups
 * split cleanly: four real topics at 0.195–0.346 and one grab-bag at 0.072.
 * 0.13 sits in the middle of that gap. Re-measure on your own brain rather than
 * trusting this number; assuming a cosine cutoff is a mistake this repo has
 * already made once.
 */
export const DEFAULT_MIN_SIM = 0.13;
/** Virtual edges are weak on purpose: faint and dashed in the renderer, and a soft pull in the layout. */
export const SPINE_STRENGTH = 0.3;

const SPINE_PREFIX = 'spine:';

export function isSpineId(id: string): boolean {
  return id.startsWith(SPINE_PREFIX);
}

function degreeMap(edges: readonly LayoutEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return deg;
}

/**
 * The one node everything hangs off, resolved deterministically.
 *
 * Replaces `nodes.find(n => n.category === 'core')`, which three call sites
 * relied on and which is an ARRAY-ORDER LOTTERY: graphify imports its "god"
 * nodes with category 'core' too, so a real brain can hold half a dozen of
 * them and the winner is whichever happens to sit first in the array.
 */
export function resolveRoot(
  nodes: readonly SpineInputNode[],
  edges: readonly LayoutEdge[],
  rootId?: string,
): string | null {
  if (rootId && nodes.some((n) => n.id === rootId)) return rootId;
  if (nodes.length === 0) return null;
  const deg = degreeMap(edges);

  // Most specific tier that has any member wins; inside a tier, highest degree,
  // then lexicographic id. Never depends on the order `nodes` arrived in.
  const tiers: Array<(n: SpineInputNode) => boolean> = [
    (n) => n.origin === 'seed' && n.category === 'core', // the hub `init` creates
    (n) => n.category === 'core',
    () => true,
  ];
  for (const match of tiers) {
    const pool = nodes.filter(match);
    if (pool.length === 0) continue;
    let best = pool[0];
    for (const n of pool) {
      const d = deg.get(n.id) ?? 0;
      const bd = deg.get(best.id) ?? 0;
      if (d > bd || (d === bd && n.id < best.id)) best = n;
    }
    return best.id;
  }
  return null;
}

type Vec = Map<string, number>;

/** Term weights for a set of nodes. Titles count double, as they do in scoreNode. */
function termVector(ids: readonly string[], byId: Map<string, SpineInputNode>): Vec {
  const v: Vec = new Map();
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    for (const t of tokenize(n.title)) v.set(t, (v.get(t) ?? 0) + 2);
    for (const t of tokenize(n.content)) v.set(t, (v.get(t) ?? 0) + 1);
  }
  return v;
}

function cosine(a: Vec, b: Vec): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o) dot += w * o;
  }
  if (dot === 0) return 0;
  let na = 0;
  let nb = 0;
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  return dot / Math.sqrt(na * nb);
}

function mergeVec(a: Vec, b: Vec): Vec {
  const v: Vec = new Map(a);
  for (const [t, w] of b) v.set(t, (v.get(t) ?? 0) + w);
  return v;
}

/** One disconnected island of the real graph. */
interface Island {
  ids: string[];
  /** Where the spine attaches — the island's most connected member. */
  anchor: string;
  vec: Vec;
}

/** A node of the tree being assembled. One island = a leaf; several = a grouping node. */
interface Cluster {
  islands: Island[];
  vec: Vec;
  /** Set only on grouping nodes; always ≤ fanout entries. */
  children?: Cluster[];
  label?: string;
  cohesion?: number;
}

/**
 * Describe a cluster by its children: how much is in there, what kind of
 * knowledge it is, and which islands it holds. Extractive on purpose — this
 * runs in the webview, where there is no LLM, and a grouping node inventing a
 * description of knowledge it does not hold would be worse than no text at all.
 */
function summarise(
  islands: readonly Island[],
  byId: Map<string, SpineInputNode>,
  maxTitles = 4,
): string {
  const ids = islands.flatMap((i) => i.ids);
  const cats = new Map<string, number>();
  for (const id of ids) {
    const c = byId.get(id)?.category;
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1);
  }
  const topCats = [...cats.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([c]) => c);

  // Each island speaks for itself through its anchor — the member the spine
  // attached to, which is also its most connected node.
  const titles = islands
    .map((i) => byId.get(i.anchor)?.title ?? i.anchor)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = titles.slice(0, maxTitles);
  const rest = titles.length - shown.length;

  const scale =
    islands.length === 1
      ? `${ids.length} node${ids.length === 1 ? '' : 's'}`
      : `${ids.length} nodes across ${islands.length} islands`;
  const kind = topCats.length ? ` · mostly ${topCats.join(' and ')}` : '';
  const list = shown.length ? ` — ${shown.join('; ')}${rest > 0 ? `; +${rest} more` : ''}` : '';
  return `${scale}${kind}${list}`;
}

/** Mean pairwise similarity among a cluster's islands. A lone island is trivially coherent. */
function cohesionOf(islands: readonly Island[]): number {
  if (islands.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      sum += cosine(islands[i].vec, islands[j].vec);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

/**
 * Merge islands into `target` clusters.
 *
 * Two details keep the result usable, and the naive version fails badly without
 * either. **Average linkage** over the ORIGINAL island vectors, rather than
 * cosine against an accumulated merged vector: a merged vector picks up every
 * term its members had, so it looks similar to everything and one cluster
 * swallows the graph. **A size cap** of `ceil(n / target)`: even with average
 * linkage, greedy merging is rich-get-richer, and the first version of this
 * produced a right-leaning chain — one group of 65 plus a handful of singletons
 * at every level, which is not a tree anyone can navigate.
 *
 * `floor` guards QUALITY: pairs below it are never merged voluntarily. `force`
 * overrides it when the fan-out rule demands fewer clusters — a readable tree
 * beats a pure one.
 */
function agglomerate(leaves: readonly Island[], target: number, floor: number, force: boolean): Cluster[] {
  const n = leaves.length;
  if (n <= target) return asLeaves(leaves);

  // Island-to-island similarity, computed once.
  const sim: number[][] = leaves.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(leaves[i].vec, leaves[j].vec);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  let groups: number[][] = leaves.map((_, i) => [i]);
  let maxSize = Math.ceil(n / target);

  const linkage = (a: number[], b: number[]): number => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += sim[i][j];
    return sum / (a.length * b.length);
  };

  while (groups.length > target) {
    let bi = -1;
    let bj = -1;
    let best = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (groups[i].length + groups[j].length > maxSize) continue;
        const s = linkage(groups[i], groups[j]);
        if (s > best) {
          best = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) {
      // Every legal merge is blocked by the cap. Loosen it rather than give up,
      // which also guarantees this loop terminates.
      maxSize++;
      continue;
    }
    if (best < floor && !force) break; // nothing left worth grouping
    const merged = [...groups[bi], ...groups[bj]];
    groups = groups.filter((_, i) => i !== bi && i !== bj);
    groups.push(merged);
  }

  // Deterministic output order: biggest first, then by smallest member index.
  groups.sort((a, b) => b.length - a.length || Math.min(...a) - Math.min(...b));
  return groups.map((g) => {
    const islands = g.map((i) => leaves[i]);
    let vec: Vec = new Map();
    for (const isl of islands) vec = mergeVec(vec, isl.vec);
    return { islands, vec };
  });
}

/**
 * Label a group by the terms that distinguish it from its SIBLINGS — plain tf
 * would just return the words every group shares.
 */
function labelGroups(groups: readonly Cluster[]): string[] {
  const df = new Map<string, number>();
  for (const g of groups) for (const t of g.vec.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(groups.length, 1);
  return groups.map((g) => {
    const scored: Array<{ t: string; w: number }> = [];
    for (const [t, tf] of g.vec) {
      const idf = Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
      if (idf <= 0) continue; // in every sibling — says nothing
      scored.push({ t, w: tf * idf });
    }
    // Deterministic: weight desc, then alphabetical.
    scored.sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const top = scored.slice(0, 3).map((s) => s.t);
    return top.length > 0 ? top.join(' · ') : 'misc';
  });
}

/** One leaf cluster per island — the starting point of every clustering round. */
function asLeaves(islands: readonly Island[]): Cluster[] {
  return islands.map((i) => ({ islands: [i], vec: i.vec }));
}

/**
 * Group `islands` so that no node ends up with more than `fanout` children,
 * inserting as many levels as that takes. This is the "sub child nodes appear
 * to guide context towards the edges" rule.
 *
 * Terminates because `target` is at least 2, so every group holds strictly
 * fewer islands than the level above it.
 */
function buildLevels(islands: Island[], fanout: number, floor: number): Cluster[] {
  if (islands.length <= fanout) return asLeaves(islands);
  // Use the WHOLE fan-out budget, not the minimum number of groups that fits.
  // Any k between ceil(n/fanout) and fanout yields a tree of the same depth, so
  // the only thing the choice changes is group size — and smaller groups are
  // more coherent. Taking the minimum instead (the first version of this) forced
  // 19 islands into 3 buckets and two of them came out as "misc".
  const target = Math.max(2, Math.min(fanout, islands.length - 1));
  const groups = agglomerate(islands, target, floor, true);
  const labels = labelGroups(groups);
  groups.forEach((g, i) => {
    g.cohesion = cohesionOf(g.islands);
    // The fan-out rule forces every island into some group, so a group is not
    // necessarily a topic. Say so rather than dressing it up in keywords.
    g.label = g.cohesion >= floor ? labels[i] : 'misc';
    // A single-island group is just that island — no grouping node, no hop.
    if (g.islands.length > 1) g.children = buildLevels(g.islands, fanout, floor);
  });
  return groups;
}

/**
 * Every pairwise island similarity, for calibrating `minSim`.
 *
 * The floor decides which islands are "the same topic", and the right value is
 * a property of the corpus, not a constant you can reason your way to — this
 * repo already shipped one assumed cosine cutoff that turned out to be wrong by
 * a wide margin. `nff-brain spine --dry-run` prints the distribution.
 */
export function islandSimilarities(
  nodes: readonly SpineInputNode[],
  edges: readonly LayoutEdge[],
  rootId?: string,
): number[] {
  const root = resolveRoot(nodes, edges, rootId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const islands = connectedComponents(nodes, edges).filter((c) => !root || !c.includes(root));
  const vecs = islands.map((ids) => termVector(ids, byId));
  const out: number[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) out.push(cosine(vecs[i], vecs[j]));
  }
  return out;
}

/**
 * Build the spine. Pure: `nodes` and `edges` are never mutated, and nothing is
 * written to disk.
 */
export function buildSpine(
  nodes: readonly SpineInputNode[],
  edges: readonly LayoutEdge[],
  opts: SpineOptions = {},
): SpineResult {
  const fanout = Math.max(2, opts.fanout ?? DEFAULT_FANOUT);
  const floor = opts.minSim ?? DEFAULT_MIN_SIM;
  const rootId = resolveRoot(nodes, edges, opts.rootId);
  const empty: SpineResult = { rootId, nodes: [], edges: [], islandCount: 0 };
  if (!rootId) return empty;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deg = degreeMap(edges);
  const comps = connectedComponents(nodes, edges);
  // The root's own component already reaches the root through REAL edges.
  const islands = comps.filter((c) => !c.includes(rootId));
  if (islands.length === 0) return { ...empty, islandCount: 0 };

  // Where the spine attaches: the island's most connected member, so the link
  // lands on its natural centre rather than an arbitrary leaf.
  const anchorOf = (ids: readonly string[]): string => {
    let best = ids[0];
    for (const id of ids) {
      const d = deg.get(id) ?? 0;
      const bd = deg.get(best) ?? 0;
      if (d > bd) best = id;
      else if (d === bd) {
        const a = byId.get(id);
        const b = byId.get(best);
        const al = a?.content.length ?? 0;
        const bl = b?.content.length ?? 0;
        if (al > bl || (al === bl && id < best)) best = id;
      }
    }
    return best;
  };

  const leaves: Island[] = islands.map((ids) => ({
    ids,
    anchor: anchorOf(ids),
    vec: termVector(ids, byId),
  }));

  const top = buildLevels(leaves, fanout, floor);

  // Emit. Level-1 clusters hang off the root; deeper ones off their parent.
  const outNodes: SpineNode[] = [];
  const outEdges: LayoutEdge[] = [];
  let seq = 0;

  const emit = (cluster: Cluster, parentId: string, level: number): void => {
    // A bare island: link its anchor straight to the parent, no grouping node.
    if (cluster.islands.length === 1) {
      outEdges.push({ from: parentId, to: cluster.islands[0].anchor, strength: SPINE_STRENGTH });
      return;
    }
    const id = `${SPINE_PREFIX}${level}-${seq++}`;
    outNodes.push({
      id,
      title: cluster.label ?? 'misc',
      level,
      memberIds: cluster.islands.flatMap((i) => i.ids),
      summary: summarise(cluster.islands, byId),
      size: Math.max(14, 26 - level * 4),
      cohesion: cluster.cohesion ?? cohesionOf(cluster.islands),
    });
    outEdges.push({ from: parentId, to: id, strength: SPINE_STRENGTH });
    for (const k of cluster.children ?? asLeaves(cluster.islands)) emit(k, id, level + 1);
  };

  for (const c of top) emit(c, rootId, 1);

  return { rootId, nodes: outNodes, edges: outEdges, islandCount: islands.length };
}
