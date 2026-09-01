// Memory-type zoning: a derived, visual-only partition of the brain into the
// four memory systems of a biological brain —
//   procedural   (skills & tools: skill trees, workflows, tool connections, playbooks)
//   semantic     (facts & pure context: analysis, rules, decisions, synced knowledge)
//   episodic     (what happened: recorder clips, mined session imports)
//   conditioning (learned reflexes: observed skill outcomes; the L2 policy graph)
//
// Same contract as spine.ts: recomputed every time it is drawn, NEVER persisted
// (spine.ts's header lists the concrete hazards a persisted grouping node hits).
// Zone ids reuse the `spine:` prefix so every existing spine renderer, filter
// and persist-guard handles them with no new cases.
//
// Browser-safe: no `node:` imports, no dependencies. Deterministic: no
// Math.random, ties broken on the ZONES order or sorted ids.

import { connectedComponents, type LayoutEdge } from './layout.js';
import { resolveRoot, SPINE_STRENGTH, type SpineNode, type SpineResult } from './spine.js';

export const ZONES = ['procedural', 'semantic', 'episodic', 'conditioning'] as const;
export type Zone = (typeof ZONES)[number];

export const ZONE_LABEL: Record<Zone, string> = {
  procedural: 'Procedural — skills & tools',
  semantic: 'Semantic — facts & context',
  episodic: 'Episodic — what happened',
  conditioning: 'Conditioning — learned reflexes',
};

/** Faint region fills for the zone overlay. The ink-and-paper surfaces apply them at low opacity. */
export const ZONE_TINT: Record<Zone, string> = {
  procedural: '#8b5cf6',
  semantic: '#0ea5e9',
  episodic: '#f59e0b',
  conditioning: '#22c55e',
};

export const ZONE_SPINE_PREFIX = 'spine:zone-';

export function zoneSpineId(zone: Zone): string {
  return `${ZONE_SPINE_PREFIX}${zone}`;
}

export function isZoneSpineId(id: string): boolean {
  return id.startsWith(ZONE_SPINE_PREFIX);
}

/** The fields a zone verdict needs. BrainNode and the admin's AdminBrainNode both satisfy it. */
export interface ZoneInputNode {
  id: string;
  category: string;
  origin?: string;
  skill?: { outcome?: { tried: number } };
}

/**
 * Which memory system a node belongs to. Derived from origin (the provenance
 * axis) plus payload presence — category only breaks the strategy/playbook
 * case. First match wins:
 *  1. conditioning — the node carries OBSERVED outcome counters (types.ts's
 *     SkillRef.outcome, written only from real results).
 *  2. procedural — a skill-tree node, a recorded workflow, a tool connection,
 *     or a distilled playbook (category 'strategy').
 *  3. episodic — captured from the browser recorder (clip) or mined from past
 *     sessions (import): records of what happened.
 *  4. semantic — everything else: facts and context (agent/seed/graphify/supabase).
 */
export function zoneOf(n: ZoneInputNode): Zone {
  if ((n.skill?.outcome?.tried ?? 0) > 0) return 'conditioning';
  if (n.skill || n.origin === 'workflow' || n.origin === 'tool' || n.category === 'strategy') return 'procedural';
  if (n.origin === 'clip' || n.origin === 'import') return 'episodic';
  return 'semantic';
}

export interface ZoneSpineOptions {
  /** Override the resolved root (see spine.ts's resolveRoot). */
  rootId?: string;
  /**
   * Nodes a zone must never absorb (the central hub, employee portals,
   * tool/tab masters — the same set the density clusters exempt). They don't
   * vote on an island's zone, and an island made ONLY of exempt nodes hangs
   * straight off the root instead of a zone.
   */
  exclude?: (n: ZoneInputNode) => boolean;
}

/**
 * Build a 4-group spine that partitions the graph into memory-type sectors,
 * shaped exactly like buildSpine's result so layoutBrain's radial wedge mode
 * and every spine renderer take it unchanged.
 *
 * Granularity is the connected ISLAND, not the node: layoutRadial parks each
 * island as a rigid body, so an island votes (majority zoneOf over its
 * non-excluded members, ties broken in ZONES order) and travels whole. Edges
 * incident to the root are ignored when carving islands — otherwise everything
 * touching the hub would be one unzoneable blob. Pass layoutBrain the same
 * root-filtered edge list (zoneLayoutEdges) when laying out with this spine,
 * or the hub's island swallows the sectors back.
 */
export function buildZoneSpine(
  nodes: readonly ZoneInputNode[],
  edges: readonly LayoutEdge[],
  opts: ZoneSpineOptions = {},
): SpineResult {
  const rootId = resolveRoot(
    nodes.map((n) => ({ id: n.id, title: '', content: '', category: n.category, origin: n.origin })),
    edges,
    opts.rootId,
  );
  const empty: SpineResult = { rootId, nodes: [], edges: [], islandCount: 0 };
  if (!rootId) return empty;

  const exclude = opts.exclude ?? (() => false);
  const interior = zoneLayoutEdges(edges, rootId);
  const zoneable = nodes.filter((n) => n.id !== rootId);
  const comps = connectedComponents(zoneable, interior);

  // Anchor = the island's most connected member (interior degree), ties on id.
  const deg = new Map<string, number>();
  for (const e of interior) {
    if (e.from === e.to) continue;
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const members: Record<Zone, string[]> = { procedural: [], semantic: [], episodic: [], conditioning: [] };
  const islands: Record<Zone, number> = { procedural: 0, semantic: 0, episodic: 0, conditioning: 0 };
  const outEdges: LayoutEdge[] = [];

  for (const comp of comps) {
    const sorted = [...comp].sort();
    let anchor = sorted[0];
    for (const id of sorted) if ((deg.get(id) ?? 0) > (deg.get(anchor) ?? 0)) anchor = id;

    const votes = new Map<Zone, number>();
    for (const id of comp) {
      const n = byId.get(id);
      if (!n || exclude(n)) continue;
      const z = zoneOf(n);
      votes.set(z, (votes.get(z) ?? 0) + 1);
    }
    if (votes.size === 0) {
      // All-exempt island (a lone portal, a tool master): keep it by the hub.
      outEdges.push({ from: rootId, to: anchor, strength: SPINE_STRENGTH });
      continue;
    }
    let zone: Zone = ZONES[0];
    for (const z of ZONES) if ((votes.get(z) ?? 0) > (votes.get(zone) ?? 0)) zone = z;
    members[zone].push(...comp);
    islands[zone]++;
    outEdges.push({ from: zoneSpineId(zone), to: anchor, strength: SPINE_STRENGTH });
  }

  // Every zone group is emitted even when empty — the conditioning sector must
  // exist for its policy-graph portal marker, and an empty group costs
  // layoutRadial only a slim wedge.
  const outNodes: SpineNode[] = ZONES.map((zone) => ({
    id: zoneSpineId(zone),
    title: ZONE_LABEL[zone],
    level: 1,
    memberIds: members[zone],
    summary:
      members[zone].length === 0
        ? 'empty'
        : `${members[zone].length} node${members[zone].length === 1 ? '' : 's'} across ${islands[zone]} island${islands[zone] === 1 ? '' : 's'}`,
    // Definitional grouping, not similarity-based — trivially coherent.
    cohesion: 1,
    size: 22,
  }));
  const zoneEdges: LayoutEdge[] = ZONES.map((zone) => ({
    from: rootId,
    to: zoneSpineId(zone),
    strength: SPINE_STRENGTH,
  }));

  return {
    rootId,
    nodes: outNodes,
    edges: [...zoneEdges, ...outEdges],
    islandCount: comps.length,
  };
}

/**
 * The edge list to hand layoutBrain alongside a zone spine: every real edge
 * except those touching the root, so the hub sits alone at the centre and its
 * former neighbours are free to settle inside their zone's wedge. Render with
 * the FULL edge list — only the layout pass wants the filtered one.
 */
export function zoneLayoutEdges(edges: readonly LayoutEdge[], rootId: string | null): LayoutEdge[] {
  if (!rootId) return [...edges];
  return edges.filter((e) => e.from !== rootId && e.to !== rootId);
}
