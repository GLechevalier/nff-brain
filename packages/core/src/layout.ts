// Force-directed layout for the brain graph.
//
// This module replaces the old arrangement, where node x/y came from
// `placeNode()`'s Math.random() and the only geometric pass was a pure
// overlap-repulsion relax (the `spaceOutNodes` below, formerly living in the
// webview's brainSpacing.ts). That made position statistically INDEPENDENT of
// connectivity: every edge was a chord between two random points, so a graph
// with a clustering coefficient of 0.65 still rendered as a hairball.
//
// Here connectivity drives geometry. Each connected component is settled
// separately — a single global simulation would fling disconnected components
// infinitely apart, since nothing pulls them back — and the settled bounding
// boxes are then packed with gutters, so the islands read as subregions through
// whitespace alone.
//
// Browser-safe: no `node:` imports, no dependencies (the webview bundles this
// into an IIFE; see packages/core/test/webviewImports.test.ts). Deterministic:
// no Math.random anywhere — seeding and tie-breaks derive from the FNV-1a hash.

export interface Pt {
  x: number;
  y: number;
}

interface SpacedNode {
  id: string;
  x: number;
  y: number;
  size: number;
}

/** A node as the layout sees it. `laidOut` marks a position a previous pass settled. */
export interface LayoutNode extends SpacedNode {
  laidOut?: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  strength: number; // 0..1
}

// Extra vertical room for the title label rendered below each node square.
export const LABEL_PAD = 14;

/**
 * Clear paper between two node squares — the single biggest lever on how spread
 * out the board feels, and the only one still doing anything: the overlap pass
 * is fully binding, so nearest-neighbour distance comes out at exactly
 * `size_a + size_b + minGap + LABEL_PAD` everywhere.
 *
 * Measured on a 103-node brain (board area / ink coverage, always 0 overlaps):
 *   60 → 16.6 Mpx / 0.75%      24 →  6.7 Mpx / 1.84%
 *   36 →  9.9 Mpx / 1.36%      10 →  4.5 Mpx / 2.78%   ← here
 *   16 →  5.4 Mpx / 2.30%       4 →  3.7 Mpx / 3.32%
 *
 * Hard floor: two 32px squares are 46px apart centre-to-centre even at minGap 0,
 * so there is little left below 4. What degrades first is not the squares but
 * the LABELS — titles are far wider than the nodes and already overlap; tighter
 * spacing overlaps more of them. That, not collision, is the real limit.
 */
export const DEFAULT_MIN_GAP = 10;
/** Clear space between rings of the radial tree. Secondary to DEFAULT_MIN_GAP. */
export const DEFAULT_RING_GAP = 60;

// Stable 32-bit string hash (FNV-1a) — for deterministic tie-breaks and for the
// webview's per-node drift direction, which derives from the same hash.
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic value in [0,1) from a string — stands in for Math.random(). */
function unit(seed: string): number {
  return hash(seed) / 4294967296;
}

export interface SpaceOutOptions {
  minGap?: number; // clear space to guarantee between two node squares (px)
  pinnedId?: string | null; // this node never moves (the central hub)
  /** Additional nodes that never move — incremental mode pins everything already settled. */
  pinned?: ReadonlySet<string> | null;
  iterations?: number;
}

/**
 * Minimum-spacing pass: relaxes ONLY overlaps, deterministically. Used as the
 * final cleanup after the force pass, which optimises for edge structure and
 * will happily leave two unrelated nodes sitting on top of each other.
 */
export function spaceOutNodes(nodes: SpacedNode[], opts: SpaceOutOptions = {}): Record<string, Pt> {
  const { minGap = 24, pinnedId = null, pinned = null, iterations = 60 } = opts;
  const pos: Record<string, Pt> = {};
  for (const n of nodes) pos[n.id] = { x: n.x, y: n.y };
  if (nodes.length < 2) return pos;
  const isPinned = (id: string) => id === pinnedId || pinned?.has(id) === true;

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const na = nodes[a];
        const nb = nodes[b];
        const pa = pos[na.id];
        const pb = pos[nb.id];
        // Squares of side size*2 → half-extent = size. Required centre distance keeps a
        // `minGap` between the squares plus a little room for the label beneath.
        const req = na.size + nb.size + minGap + LABEL_PAD;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= req) continue;
        if (dist < 0.01) {
          // Exactly coincident: pick a deterministic direction from the id hashes.
          dx = ((hash(na.id + nb.id) % 100) - 50) / 50 || 1;
          dy = ((hash(nb.id + na.id) % 100) - 50) / 50 || 1;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
        }
        const sep = (req - dist) / dist; // scale factor to reach the required distance
        const ox = dx * sep;
        const oy = dy * sep;
        const aPinned = isPinned(na.id);
        const bPinned = isPinned(nb.id);
        if (aPinned && bPinned) continue;
        if (aPinned) {
          pb.x += ox;
          pb.y += oy;
        } else if (bPinned) {
          pa.x -= ox;
          pa.y -= oy;
        } else {
          pa.x -= ox * 0.5;
          pa.y -= oy * 0.5;
          pb.x += ox * 0.5;
          pb.y += oy * 0.5;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos;
}

export interface Neighbour {
  id: string;
  strength: number;
}

/**
 * Undirected adjacency. Edges whose endpoints aren't in `nodes` are dropped.
 * Takes bare `{id}` so callers that have no coordinates (spine.ts) can use it.
 */
export function buildAdjacency(
  nodes: readonly { id: string }[],
  edges: readonly LayoutEdge[],
): Map<string, Neighbour[]> {
  const adj = new Map<string, Neighbour[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    const a = adj.get(e.from);
    const b = adj.get(e.to);
    if (!a || !b || e.from === e.to) continue;
    a.push({ id: e.to, strength: e.strength });
    b.push({ id: e.from, strength: e.strength });
  }
  return adj;
}

/**
 * Connected components, largest first. Iterative DFS (an explicit stack, not
 * recursion — a long chain of nodes would otherwise blow the call stack).
 * Ordering is fully deterministic: size desc, then the lexicographically
 * smallest member id, so the packing step lays the same graph out identically
 * every run.
 */
export function connectedComponents(
  nodes: readonly { id: string }[],
  edges: readonly LayoutEdge[],
): string[][] {
  const adj = buildAdjacency(nodes, edges);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    seen.add(n.id);
    const comp: string[] = [];
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of adj.get(v) ?? []) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        stack.push(w.id);
      }
    }
    comp.sort();
    out.push(comp);
  }
  out.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/**
 * The navigational spine, as the layout needs to see it. Structurally satisfied
 * by spine.ts's `SpineResult` — declared here rather than imported because
 * spine.ts imports this module, and the dependency has to run one way.
 */
export interface LayoutSpine {
  rootId: string | null;
  nodes: ReadonlyArray<{ id: string; level: number; memberIds: string[]; size: number }>;
  edges: readonly LayoutEdge[];
}

export interface LayoutOptions {
  /** Force-pass iterations. Defaults to 300 full / 120 incremental. */
  iterations?: number;
  /** Clear space between node squares, handed to the final overlap pass. */
  minGap?: number;
  /** Empty space between component bounding boxes. Must exceed minGap so islands read as separate. */
  componentGutter?: number;
  /** Keep `laidOut` nodes exactly where they are; only settle the new ones. */
  incremental?: boolean;
  /** Never moved by the overlap pass (the central hub). */
  pinnedId?: string | null;
  /** The whole arrangement is centred here. Defaults to the canonical (400, 300). */
  center?: Pt;
  /**
   * When supplied, a FULL pass arranges the graph as a radial tree along this
   * spine instead of shelf-packing disconnected islands. An INCREMENTAL pass
   * still preserves stored positions — the spine nodes are then placed relative
   * to their members, so adopting the tree takes one `layout --full`.
   */
  spine?: LayoutSpine | null;
  /** Clear space between the rings of the radial tree. */
  ringGap?: number;
}

// Fruchterman–Reingold scale constant. 0.9 packs a component slightly tighter
// than the ideal edge length, which keeps islands compact against their gutters.
const FR_C = 0.9;

interface Body {
  id: string;
  x: number;
  y: number;
  size: number;
  frozen: boolean;
}

/**
 * Fruchterman–Reingold on ONE component. Repulsion is all-pairs within the
 * component (which is why components are settled separately — O(Σ nᵢ²) instead
 * of O(n²), and no cross-component blow-apart), attraction runs along edges
 * weighted by strength.
 *
 * Weighting by strength matters more than it looks: most edges in a real brain
 * are the weak "written in the same session" provenance tier, which encodes
 * WHEN a node was learned, not what it is about. Semantic edges score much
 * higher and so pull correspondingly harder.
 */
function settleComponent(
  bodies: Body[],
  adj: Map<string, Neighbour[]>,
  iterations: number,
  minGap: number,
): void {
  const n = bodies.length;
  if (n < 2) return;

  const byId = new Map(bodies.map((b) => [b.id, b]));
  let avgSize = 0;
  for (const b of bodies) avgSize += b.size;
  avgSize /= n;

  // Ideal edge length k = C·sqrt(area/n) with area = n·cell², i.e. C·cell — so
  // the layout self-scales with node size instead of spilling past the
  // renderer's minimum zoom.
  const cell = 2 * avgSize + minGap;
  const k = FR_C * cell;
  const kk = k * k;

  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);
  let temp = k * 1.5;
  const cooling = temp / (iterations + 1);

  for (let iter = 0; iter < iterations; iter++) {
    dispX.fill(0);
    dispY.fill(0);

    // Repulsion, all pairs in this component.
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const ba = bodies[a];
        const bb = bodies[b];
        let dx = ba.x - bb.x;
        let dy = ba.y - bb.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) {
          // Coincident: same deterministic escape hatch the overlap pass uses.
          dx = ((hash(ba.id + bb.id) % 100) - 50) / 50 || 1;
          dy = ((hash(bb.id + ba.id) % 100) - 50) / 50 || 1;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
        }
        const f = kk / dist / dist; // k²/d, normalised by dist to reuse dx/dy
        dispX[a] += dx * f;
        dispY[a] += dy * f;
        dispX[b] -= dx * f;
        dispY[b] -= dy * f;
      }
    }

    // Attraction along edges. Each edge is visited twice (once from each end),
    // which is exactly the symmetric pull we want.
    for (let a = 0; a < n; a++) {
      const ba = bodies[a];
      for (const nb of adj.get(ba.id) ?? []) {
        const bb = byId.get(nb.id);
        if (!bb) continue; // other component — cannot happen, but cheap to guard
        const dx = ba.x - bb.x;
        const dy = ba.y - bb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) continue;
        const f = (nb.strength * dist) / k; // d²/k, normalised by dist
        dispX[a] -= dx * f;
        dispY[a] -= dy * f;
      }
    }

    // Apply, capped by the current temperature.
    for (let a = 0; a < n; a++) {
      const b = bodies[a];
      if (b.frozen) continue;
      const dx = dispX[a];
      const dy = dispY[a];
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 1e-9) continue;
      const step = Math.min(mag, temp) / mag;
      b.x += dx * step;
      b.y += dy * step;
    }
    temp -= cooling;
  }
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(bodies: readonly Body[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bodies) {
    minX = Math.min(minX, b.x - b.size);
    minY = Math.min(minY, b.y - b.size);
    maxX = Math.max(maxX, b.x + b.size);
    maxY = Math.max(maxY, b.y + b.size + LABEL_PAD); // the label sits below the square
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Settle the graph. Returns a position per node id.
 *
 * Pure and deterministic: identical input yields byte-identical output, which
 * is what lets the webview re-run this on every load without the picture
 * shifting under the reader.
 */
export function layoutBrain(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  opts: LayoutOptions = {},
): Record<string, Pt> {
  // Both tunable per run: `layout --min-gap N --ring-gap N`.
  const {
    minGap = DEFAULT_MIN_GAP,
    componentGutter = 180,
    ringGap = DEFAULT_RING_GAP,
    pinnedId = null,
    center = { x: 400, y: 300 },
    spine = null,
  } = opts;

  const pos: Record<string, Pt> = {};
  if (nodes.length === 0) return pos;

  // Incremental means "preserve the settled board". If nothing is settled there
  // is no board to preserve, and honouring the flag would leave every node on
  // placeNode's random coordinates with only a light nudge — i.e. the very
  // hairball this module exists to fix. Fall back to a full pass.
  const incremental = (opts.incremental ?? false) && nodes.some((n) => n.laidOut);
  const iterations = opts.iterations ?? (incremental ? 120 : 300);

  // A radial tree is a GLOBAL arrangement — it cannot be built around positions
  // it is forbidden to move. So a spine drives a full pass only; incremental
  // keeps the stored board and just hangs the spine nodes off their members.
  if (spine?.rootId && nodes.some((n) => n.id === spine.rootId) && !incremental) {
    return layoutRadial(nodes, edges, spine, { minGap, ringGap, center, iterations, pinnedId });
  }

  const adj = buildAdjacency(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const comps = connectedComponents(nodes, edges);
  // Where an incremental pass may park a component that has no settled node to
  // anchor to (every member is new) — off the right edge of what already exists.
  const parking = incremental ? parkingSpot(nodes, componentGutter) : null;

  const settled: Array<{ bodies: Body[]; box: Box }> = [];

  for (const comp of comps) {
    const bodies = seedComponent(comp, byId, adj, incremental, minGap, parking);
    // In incremental mode a component with nothing new in it is already
    // settled; re-running the force pass would only re-jitter a stable picture.
    const dirty = !incremental || bodies.some((b) => !b.frozen);
    if (dirty) {
      settleComponent(bodies, adj, iterations, minGap);
      // Pin everything already settled, so the overlap pass resolves collisions
      // by moving the NEW node aside rather than splitting the push between them.
      const frozen = new Set(bodies.filter((b) => b.frozen).map((b) => b.id));
      const spaced = spaceOutNodes(bodies, {
        minGap,
        pinnedId,
        pinned: frozen.size > 0 ? frozen : null,
      });
      for (const b of bodies) {
        if (b.frozen) continue;
        b.x = spaced[b.id].x;
        b.y = spaced[b.id].y;
      }
    }
    settled.push({ bodies, box: boundsOf(bodies) });
  }

  // In incremental mode components already hold absolute coordinates carried
  // over from the previous pass — repacking would shuffle the whole board and
  // break the promise that settled nodes never move.
  if (incremental) {
    for (const { bodies } of settled) for (const b of bodies) pos[b.id] = { x: b.x, y: b.y };
    if (spine) placeSpineNearMembers(spine, pos, center);
    return pos;
  }

  packComponents(settled, componentGutter, center, pos);
  if (spine) placeSpineNearMembers(spine, pos, center);
  return pos;
}

interface SettledIsland {
  bodies: Body[];
  /** Distance from the island's centroid to its furthest edge. */
  radius: number;
}

/**
 * Arrange the graph as a radial tree along the spine.
 *
 * The root sits at the centre with its own island around it; every level of the
 * tree is a ring further out; and each subtree owns an angular WEDGE sized by
 * how much arc its islands actually need, so a fat island gets room and a lone
 * node does not waste a quadrant. Islands themselves are still settled by the
 * force pass — this only decides where each settled island is parked.
 *
 * Shelf packing (packComponents) cannot be used here: with a spine the graph is
 * one component, and a single force simulation over everything would collapse
 * the tree back into a blob.
 */
function layoutRadial(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  spine: LayoutSpine,
  opts: { minGap: number; ringGap: number; center: Pt; iterations: number; pinnedId: string | null },
): Record<string, Pt> {
  const { minGap, ringGap, center, iterations, pinnedId } = opts;
  const rootId = spine.rootId!;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = buildAdjacency(nodes, edges);

  // 1. Settle every island on its own, centred on its own centroid so it can be
  //    parked anywhere as a rigid body.
  const comps = connectedComponents(nodes, edges);
  const islandOf = new Map<string, SettledIsland>();
  for (const comp of comps) {
    const bodies = seedComponent(comp, byId, adj, false, minGap, null);
    settleComponent(bodies, adj, iterations, minGap);
    const spaced = spaceOutNodes(bodies, { minGap });
    for (const b of bodies) {
      b.x = spaced[b.id].x;
      b.y = spaced[b.id].y;
    }
    let cx = 0;
    let cy = 0;
    for (const b of bodies) {
      cx += b.x;
      cy += b.y;
    }
    cx /= bodies.length;
    cy /= bodies.length;
    let radius = 0;
    for (const b of bodies) {
      b.x -= cx;
      b.y -= cy;
      radius = Math.max(radius, Math.hypot(b.x, b.y) + b.size + LABEL_PAD);
    }
    const island: SettledIsland = { bodies, radius };
    for (const b of bodies) islandOf.set(b.id, island);
  }

  // 2. The tree. Spine edges always point parent → child, so no direction guessing.
  const kids = new Map<string, string[]>();
  for (const e of spine.edges) (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to);
  const spineById = new Map(spine.nodes.map((n) => [n.id, n]));

  /** Arc length this subtree needs at its ring. */
  const demandCache = new Map<string, number>();
  const demand = (id: string): number => {
    const hit = demandCache.get(id);
    if (hit !== undefined) return hit;
    const cs = kids.get(id) ?? [];
    let d: number;
    if (cs.length === 0) {
      d = 2 * (islandOf.get(id)?.radius ?? byId.get(id)?.size ?? 16) + minGap;
    } else {
      let sum = 0;
      for (const c of cs) sum += demand(c);
      const own = 2 * (spineById.get(id)?.size ?? 16) + minGap;
      d = Math.max(sum, own);
    }
    demandCache.set(id, d);
    return d;
  };

  /** How much space this node's own body takes: its island, or the mark itself. */
  const thickness = (id: string): number =>
    (kids.get(id)?.length ?? 0) === 0
      ? (islandOf.get(id)?.radius ?? 16)
      : (spineById.get(id)?.size ?? 16);

  // 4. Walk the tree, splitting each wedge among the children by demand.
  //
  // Radius is computed PER SUBTREE, not as one ring per level. A shared ring is
  // sized by the neediest branch on it, so a group of three small islands got
  // pushed out as far as the 25-node one — which is how the board ended up 0.3%
  // ink. Here a node sits just outside its parent, and is only pushed further
  // out if its own wedge is too narrow to hold it (arc = radius × angle).
  const pos: Record<string, Pt> = {};
  const park = (id: string, at: Pt): void => {
    const island = islandOf.get(id);
    if (!island) {
      pos[id] = at;
      return;
    }
    for (const b of island.bodies) pos[b.id] = { x: at.x + b.x, y: at.y + b.y };
  };

  const place = (id: string, a0: number, a1: number, parentR: number, level: number): void => {
    const own = thickness(id);
    let r = 0;
    if (level === 0) park(id, center);
    else {
      const span = Math.max(a1 - a0, 1e-6);
      // Just outside the parent, unless this subtree's wedge is too narrow at
      // that distance to hold what hangs off it.
      r = Math.max(parentR + ringGap + own, demand(id) / span);
      const mid = (a0 + a1) / 2;
      park(id, { x: center.x + r * Math.cos(mid), y: center.y + r * Math.sin(mid) });
    }
    const cs = kids.get(id) ?? [];
    if (cs.length === 0) return;
    let total = 0;
    for (const c of cs) total += demand(c);
    if (total <= 0) total = 1;
    let a = a0;
    for (const c of cs) {
      const w = ((a1 - a0) * demand(c)) / total;
      place(c, a, a + w, r + own, level + 1);
      a += w;
    }
  };
  // Start at -π/2 so the first branch leaves the root upward rather than right.
  place(rootId, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI, islandOf.get(rootId)?.radius ?? 0, 0);

  // Any island the spine never reached (should not happen — buildSpine links
  // them all — but a hand-built spine could omit one) still needs a home: below
  // everything already placed, where the overlap pass will separate them.
  let below = 0;
  for (const p of Object.values(pos)) below = Math.max(below, p.y - center.y);
  for (const comp of comps) {
    if (comp.some((id) => pos[id])) continue;
    below += ringGap;
    park(comp[0], { x: center.x, y: center.y + below });
  }

  // 5. Residual overlap: wedges can crowd where two rings nearly touch.
  const all = [...nodes.map((n) => ({ id: n.id, size: n.size })), ...spine.nodes.map((n) => ({ id: n.id, size: n.size }))]
    .filter((n) => pos[n.id])
    .map((n) => ({ id: n.id, x: pos[n.id].x, y: pos[n.id].y, size: n.size }));
  const spaced = spaceOutNodes(all, { minGap, pinnedId: pinnedId ?? rootId });
  for (const n of all) pos[n.id] = spaced[n.id];
  return pos;
}

/**
 * Place spine nodes against ALREADY-SETTLED member positions, for the
 * incremental path — where the promise is that stored positions never move, so
 * the tree cannot be re-arranged around them. Each grouping node sits on the
 * line from the root to its members' centroid, which reads as a hub feeding
 * outward without disturbing anything.
 */
function placeSpineNearMembers(
  spine: LayoutSpine,
  pos: Record<string, Pt>,
  center: Pt,
): void {
  const root = spine.rootId ? pos[spine.rootId] : null;
  const from = root ?? center;
  // Deepest first, so a parent can lean on children it has already placed.
  const ordered = [...spine.nodes].sort((a, b) => b.level - a.level);
  for (const s of ordered) {
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const id of s.memberIds) {
      const p = pos[id];
      if (!p) continue;
      cx += p.x;
      cy += p.y;
      n++;
    }
    if (n === 0) {
      pos[s.id] = from;
      continue;
    }
    cx /= n;
    cy /= n;
    // Sit between the root and the group, closer to the group than the root so
    // the hierarchy reads outward.
    const t = 0.55 + 0.1 * Math.max(0, s.level - 1);
    pos[s.id] = { x: from.x + (cx - from.x) * t, y: from.y + (cy - from.y) * t };
  }
}

/** Right edge of the already-settled region, used to park brand-new components. */
function parkingSpot(nodes: readonly LayoutNode[], gutter: number): Pt | null {
  let maxX = -Infinity;
  let minY = Infinity;
  for (const n of nodes) {
    if (!n.laidOut) continue;
    maxX = Math.max(maxX, n.x + n.size);
    minY = Math.min(minY, n.y);
  }
  return Number.isFinite(maxX) ? { x: maxX + gutter, y: minY } : null;
}

/**
 * Initial positions for one component's bodies.
 *
 * Fresh: on a circle, so the force pass starts from an even spread rather than
 * a clump it has to spend its whole cooling schedule escaping.
 * Incremental: settled nodes are frozen in place and each new node starts at
 * the centroid of its settled neighbours, so it lands in the right neighbourhood
 * immediately instead of migrating across the board.
 */
function seedComponent(
  comp: readonly string[],
  byId: Map<string, LayoutNode>,
  adj: Map<string, Neighbour[]>,
  incremental: boolean,
  minGap: number,
  parking: Pt | null,
): Body[] {
  const bodies: Body[] = [];
  const n = comp.length;

  if (!incremental) {
    // Radius that gives each node roughly `cell` of circumference to itself.
    let avgSize = 0;
    for (const id of comp) avgSize += byId.get(id)!.size;
    avgSize /= n;
    const cell = 2 * avgSize + minGap;
    const radius = n < 2 ? 0 : (n * cell) / (2 * Math.PI);
    comp.forEach((id, i) => {
      const node = byId.get(id)!;
      const angle = (2 * Math.PI * i) / n + unit(id) * 0.4;
      bodies.push({
        id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: node.size,
        frozen: false,
      });
    });
    return bodies;
  }

  // Incremental: keep what is already settled.
  const anchored = new Map<string, Pt>();
  for (const id of comp) {
    const node = byId.get(id)!;
    if (node.laidOut) anchored.set(id, { x: node.x, y: node.y });
  }

  let cx = 0;
  let cy = 0;
  for (const p of anchored.values()) {
    cx += p.x;
    cy += p.y;
  }
  if (anchored.size > 0) {
    cx /= anchored.size;
    cy /= anchored.size;
  }

  for (const id of comp) {
    const node = byId.get(id)!;
    const settled = anchored.get(id);
    if (settled) {
      bodies.push({ id, x: settled.x, y: settled.y, size: node.size, frozen: true });
      continue;
    }
    // Seed beside the settled neighbours; fall back to the component centroid,
    // then to the node's own (random) coordinates if nothing is settled at all.
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const nb of adj.get(id) ?? []) {
      const p = anchored.get(nb.id);
      if (!p) continue;
      sx += p.x;
      sy += p.y;
      count++;
    }
    const base =
      count > 0
        ? { x: sx / count, y: sy / count }
        : anchored.size > 0
          ? { x: cx, y: cy }
          : // Nothing in this component is settled: park it clear of the
            // existing board rather than leaving it on placeNode's random spot,
            // where it would land on top of an established island.
            (parking ?? { x: node.x, y: node.y });
    // Offset off the anchor so the force pass has a gradient to work with —
    // starting exactly on top of a neighbour gives it a zero-length vector.
    const angle = unit(id) * 2 * Math.PI;
    const r = 2 * node.size + minGap;
    bodies.push({
      id,
      x: base.x + Math.cos(angle) * r,
      y: base.y + Math.sin(angle) * r,
      size: node.size,
      frozen: false,
    });
  }
  return bodies;
}

/**
 * Shelf-pack the settled component boxes, largest first, wrapping at a width
 * that targets a ~4:3 board. Gutters guarantee the boxes never touch, so no
 * global overlap pass is needed afterwards — and running one would be actively
 * harmful, since it is exactly the force that erodes the island separation.
 */
function packComponents(
  settled: Array<{ bodies: Body[]; box: Box }>,
  gutter: number,
  center: Pt,
  out: Record<string, Pt>,
): void {
  let area = 0;
  for (const s of settled) {
    area += (s.box.maxX - s.box.minX + gutter) * (s.box.maxY - s.box.minY + gutter);
  }
  const maxRowWidth = Math.max(Math.sqrt(area * (4 / 3)), 1);

  let rowX = 0;
  let rowY = 0;
  let rowHeight = 0;
  let boardMaxX = 0;
  const placed: Array<{ bodies: Body[]; dx: number; dy: number }> = [];

  for (const s of settled) {
    const w = s.box.maxX - s.box.minX;
    const h = s.box.maxY - s.box.minY;
    if (rowX > 0 && rowX + w > maxRowWidth) {
      rowY += rowHeight + gutter;
      rowX = 0;
      rowHeight = 0;
    }
    placed.push({ bodies: s.bodies, dx: rowX - s.box.minX, dy: rowY - s.box.minY });
    rowX += w + gutter;
    boardMaxX = Math.max(boardMaxX, rowX - gutter);
    rowHeight = Math.max(rowHeight, h);
  }
  const boardMaxY = rowY + rowHeight;

  // Centre the whole board on the requested origin.
  const ox = center.x - boardMaxX / 2;
  const oy = center.y - boardMaxY / 2;
  for (const p of placed) {
    for (const b of p.bodies) out[b.id] = { x: b.x + p.dx + ox, y: b.y + p.dy + oy };
  }
}
