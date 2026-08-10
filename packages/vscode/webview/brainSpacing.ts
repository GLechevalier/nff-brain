// Minimum-spacing pass for the Brain graph, ported verbatim from
// nff-dashboard/src/utils/brainSpacing.ts. Nodes carry curated/stored x/y, so we
// do NOT re-run a force layout that would throw the arrangement away — we relax
// ONLY overlaps, deterministically (id-hash tie-breaks, no Math.random), and the
// central node is pinned so the graph keeps its anchor.

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

// Extra vertical room for the title label rendered below each node square.
const LABEL_PAD = 14;

// Stable 32-bit string hash (FNV-1a) — for deterministic tie-breaks.
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SpaceOutOptions {
  minGap?: number; // clear space to guarantee between two node squares (px)
  pinnedId?: string | null; // this node never moves (the central hub)
  iterations?: number;
}

export function spaceOutNodes(nodes: SpacedNode[], opts: SpaceOutOptions = {}): Record<string, Pt> {
  const { minGap = 24, pinnedId = null, iterations = 60 } = opts;
  const pos: Record<string, Pt> = {};
  for (const n of nodes) pos[n.id] = { x: n.x, y: n.y };
  if (nodes.length < 2) return pos;

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
        const aPinned = na.id === pinnedId;
        const bPinned = nb.id === pinnedId;
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
