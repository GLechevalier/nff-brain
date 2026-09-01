// Overlap-triggered merging: nodes whose squares visually overlap at the
// current zoom fuse into one blob — Agar.io style. Transitive and
// category-blind: whatever is stacked on screen becomes ONE node, anchored on
// its largest member, which renders in that member's own shape/size class,
// grown by the mass it absorbed. Same contract as the old statistical
// clustering it replaces: pure, deterministic, never persisted, recomputed
// every render, hides its members.
//
// Why anchor-based: the previous design had TWO render paths — a generic
// "×N" cluster square, plus an invisible hit-target for clusters "merged
// into" a nearby hub (nearBigNodeId) — and the second path twice regressed
// into "fully dezoomed, nothing visible" (an invisible cluster anchored to a
// node that was itself hidden). Anchoring every blob on its own largest
// member makes the invariant structural: the anchor is a member, members are
// hidden EXCEPT the anchor, so a blob can never be anchored to something
// hidden.
//
// The merge trigger is the SAME axis-aligned geometry layoutBrain/spaceOutNodes
// guarantee (layout.ts's requiredSeparation): two squares of half-extent
// `size` overlap when |dx| < sa+sb and |dy| < sa+sb+LABEL_PAD. `slack` widens
// that test; callers with a zoomable view pass MERGE_SCREEN_SLACK / scale so
// "looks stacked at this zoom" is the trigger — zoom out and blobs coalesce,
// zoom in and they dissolve back into real nodes.
//
// Browser-safe: no `node:` imports, no dependencies (see
// packages/core/test/webviewImports.test.ts).

import type { LayoutEdge } from './layout.js';

/** The fields overlap merging needs. BrainNode, the webview's ViewNode, and
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

/** A blob standing in for 2+ overlapping real nodes. Never persisted. */
export interface DensityCluster {
  id: string; // always `density:…` — mirrors spine's `spine:` prefix, can't collide with a real node id
  /** Dominant category among members (ties → the anchor's) — glyph/caption fallback only; a blob is by definition possibly mixed. */
  category: string;
  /** ALL members, anchor included, sorted by id. Renderers hide every member EXCEPT the anchor. */
  memberIds: string[];
  /** The largest member (ties → lowest id). The blob renders AS this node — its position, its glyph/logo — grown to `size`. */
  anchorId: string;
  /** Extractive, not generated: count + a few member titles. Same philosophy as spine's summarise(). */
  summary: string;
  /** The anchor's render size after absorbing the other members — blobSize(anchor.size, [their sizes]), area-conserving. */
  size: number;
}

export interface DensityOptions {
  /**
   * Extra board-space gap within which two squares still count as
   * overlapping. A zoomable caller passes `MERGE_SCREEN_SLACK / scale` so the
   * test tracks what the viewer actually sees; 0 means true geometric
   * overlap only.
   */
  slack?: number;
  /**
   * Ids of nodes that must ALWAYS stay visible (the central hub, tab and
   * tool masters). A protected node can still anchor a blob — it absorbs
   * whatever overlaps it — but it can never be hidden as another blob's
   * member: it wins the anchor pick over any size, and two protected nodes
   * never merge with each other (each keeps its own square on the board).
   */
  protectedIds?: ReadonlySet<string>;
}

/**
 * Screen-pixel radius of the density HEATMAP blobs (the "▦ Density" toggle),
 * resolved against the current zoom by that feature. The merge trigger below
 * deliberately does NOT use it — heat spreads much wider than "these squares
 * are stacked".
 */
export const DEFAULT_DENSITY_SCREEN_RADIUS = 90;

/**
 * Screen-px gap between two node squares' edges under which they read as
 * stacked and merge. Callers pass `MERGE_SCREEN_SLACK / view.scale` as
 * `slack`.
 */
export const MERGE_SCREEN_SLACK = 16;

// Mirrors layout.ts's LABEL_PAD: the title strip under each square that
// requiredSeparation already treats as part of the node's vertical footprint.
const LABEL_PAD = 14;

// Chain-eating rounds: a grown blob can overlap nodes its base anchor did
// not; each round re-tests with grown sizes. Converges almost immediately on
// real graphs — the cap is a safety net, not a tuning knob.
const MAX_GROW_ROUNDS = 5;

const DENSITY_PREFIX = 'density:';

export function isDensityClusterId(id: string): boolean {
  return id.startsWith(DENSITY_PREFIX);
}

/** How big an anchor of base half-extent `anchorSize` renders after absorbing
 *  members of half-extents `absorbedSizes` — Agar.io mass conservation: the
 *  blob's AREA is the sum of its members' areas, so its half-extent is
 *  sqrt(anchor² + Σ memberᵢ²). Eating a same-size peer grows a node ~41%;
 *  eating something tiny barely registers — growth is proportional to what
 *  was actually swallowed, and visibly so. THE shared mass-growth rule. */
export function blobSize(anchorSize: number, absorbedSizes: readonly number[]): number {
  let area = anchorSize * anchorSize;
  for (const s of absorbedSizes) area += s * s;
  return Math.sqrt(area);
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

/** Two squares (half-extents sa/sb) overlap, with `slack` extra gap allowed —
 *  the same AABB footprint requiredSeparation enforces, label strip included. */
function overlaps(
  ax: number, ay: number, sa: number,
  bx: number, by: number, sb: number,
  slack: number,
): boolean {
  return Math.abs(ax - bx) < sa + sb + slack && Math.abs(ay - by) < sa + sb + LABEL_PAD + slack;
}

/** The anchor of a member set: the protected member if there is one (the
 *  union guard allows at most one per group), else largest size, ties →
 *  lowest id. */
function pickAnchor(
  memberIds: readonly string[],
  byId: Map<string, DensityInputNode>,
  protectedIds: ReadonlySet<string>,
): DensityInputNode {
  let anchor = byId.get(memberIds[0])!;
  for (const id of memberIds) {
    const n = byId.get(id)!;
    if (protectedIds.has(n.id)) return n;
    if (n.size > anchor.size || (n.size === anchor.size && n.id < anchor.id)) anchor = n;
  }
  return anchor;
}

/**
 * Build overlap blobs for the current graph. Pure: `nodes` and `edges` are
 * never mutated, nothing is written to disk. `edges` is accepted for
 * call-site compatibility but not consulted — merging is purely geometric.
 */
export function buildDensityClusters(
  nodes: readonly DensityInputNode[],
  edges: readonly LayoutEdge[],
  opts: DensityOptions = {},
): DensityCluster[] {
  void edges;
  const slack = opts.slack ?? 0;
  const protectedIds = opts.protectedIds ?? new Set<string>();
  if (nodes.length < 2) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Union-find over node ids, deterministic: roots resolve to the lowest id
  // on union, and pairs are scanned in the sorted order below. Each root
  // tracks how many protected members its group holds — a union that would
  // put two protected nodes in one group is refused, so every protected node
  // either stands alone or anchors its own blob (never hides behind another).
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
  const protCount = new Map<string, number>(nodes.map((n) => [n.id, protectedIds.has(n.id) ? 1 : 0]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    // Path compression.
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    const prot = protCount.get(ra)! + protCount.get(rb)!;
    if (prot > 1) return false; // both groups hold a must-stay-visible node
    const root = ra < rb ? ra : rb;
    parent.set(ra < rb ? rb : ra, root);
    protCount.set(root, prot);
    return true;
  };

  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Chain-eating: each round replaces every group by its anchor grown to the
  // group's blob size and re-tests overlaps, so a blob that got fatter can
  // absorb what its base anchor never touched. ponytail: O(rounds·n²)
  // pairwise scan — fine at brain-graph sizes (tens–hundreds of nodes);
  // switch to a spatial grid if that stops being true.
  for (let round = 0; round < MAX_GROW_ROUNDS; round++) {
    // Current super-node per group root: anchor position, grown size.
    const members = new Map<string, string[]>();
    for (const n of sorted) {
      const root = find(n.id);
      (members.get(root) ?? members.set(root, []).get(root)!).push(n.id);
    }
    const supers = [...members.values()].map((ids) => {
      const anchor = pickAnchor(ids, byId, protectedIds);
      const absorbed = ids.filter((id) => id !== anchor.id).map((id) => byId.get(id)!.size);
      return { root: find(anchor.id), x: anchor.x, y: anchor.y, size: blobSize(anchor.size, absorbed) };
    });
    supers.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));

    let merged = false;
    for (let i = 0; i < supers.length; i++) {
      for (let j = i + 1; j < supers.length; j++) {
        const a = supers[i];
        const b = supers[j];
        if (overlaps(a.x, a.y, a.size, b.x, b.y, b.size, slack)) {
          if (union(a.root, b.root)) merged = true;
        }
      }
    }
    if (!merged) break;
  }

  // Groups of 2+ become blobs; singletons stay ordinary nodes.
  const groups = new Map<string, string[]>();
  for (const n of sorted) {
    const root = find(n.id);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(n.id);
  }
  const found = [...groups.values()].filter((ids) => ids.length >= 2);

  // Deterministic output order: biggest first, then by lowest member id — same
  // tie-break discipline as spine.ts's agglomerate().
  found.sort(
    (a, b) =>
      b.length - a.length ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  let seq = 0;
  return found.map((memberIds) => {
    const anchor = pickAnchor(memberIds, byId, protectedIds);
    // Dominant category (ties → the anchor's own).
    const tally = new Map<string, number>();
    for (const id of memberIds) {
      const c = byId.get(id)!.category;
      tally.set(c, (tally.get(c) ?? 0) + 1);
    }
    let category = anchor.category;
    let best = tally.get(category) ?? 0;
    for (const [c, count] of [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (count > best) {
        best = count;
        category = c;
      }
    }
    return {
      id: `${DENSITY_PREFIX}blob-${seq++}`,
      category,
      memberIds, // already sorted (built from `sorted`)
      anchorId: anchor.id,
      summary: summarise(memberIds, byId),
      size: blobSize(
        anchor.size,
        memberIds.filter((id) => id !== anchor.id).map((id) => byId.get(id)!.size),
      ),
    };
  });
}
