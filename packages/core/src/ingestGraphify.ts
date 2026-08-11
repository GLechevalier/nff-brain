// Import a graphify knowledge graph (graphify-out/graph.json, networkx
// node-link JSON) into the brain as a small set of CODEBASE-MAP nodes:
// per repo at most `maxPerRepo` nodes — areas (communities), flows
// (hyperedges) and gods (hub entities) — each carrying a `graphifyRef`
// bridge back to the child graphify nodes it summarizes. Imported nodes
// use origin 'graphify': never folded/evicted, replaced wholesale on
// re-ingest (so nothing may ever be merged INTO them).

import { extractJson } from './distill.js';
import { removeNode, upsertEdge, upsertNode } from './store.js';
import {
  clampStrength,
  placeNode,
  slug,
  type BrainEdge,
  type BrainFile,
  type BrainNode,
  type GraphifyRef,
} from './types.js';

// ── graphify file shapes (defensive: third-party format) ─────────────────────

export interface GraphifyNode {
  id: string;
  label: string;
  fileType: string;
  sourceFile: string;
  community: number | null;
}

export interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  confidenceScore: number; // 0..1
}

export interface GraphifyHyperedge {
  id: string;
  label: string;
  nodes: string[];
  relation: string;
  confidenceScore: number;
  sourceFile: string;
}

export interface GraphifyGraph {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
  hyperedges: GraphifyHyperedge[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clampStrength(v) : fallback;
}

/** Parse graphify's node-link JSON. Throws a descriptive Error on unknown shapes. */
export function parseGraphifyGraph(jsonText: string): GraphifyGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error('graph.json is not valid JSON');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj || !Array.isArray(obj.nodes) || !Array.isArray(obj.links)) {
    throw new Error('unrecognized graph.json — expected node-link JSON with "nodes" and "links" arrays');
  }

  const nodes: GraphifyNode[] = [];
  for (const n of obj.nodes as Array<Record<string, unknown>>) {
    const id = str(n?.id);
    if (!id) continue;
    nodes.push({
      id,
      label: str(n.label) || id,
      fileType: str(n.file_type),
      sourceFile: str(n.source_file),
      community: typeof n.community === 'number' ? n.community : null,
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const links: GraphifyLink[] = [];
  for (const l of obj.links as Array<Record<string, unknown>>) {
    const source = str(l?.source);
    const target = str(l?.target);
    if (!ids.has(source) || !ids.has(target)) continue;
    links.push({
      source,
      target,
      relation: str(l.relation) || 'related',
      confidenceScore: num01(l.confidence_score, num01(l.weight, 0.6)),
    });
  }

  // graphify writes hyperedges both top-level and under graph.hyperedges.
  const graphAttrs = (obj.graph ?? {}) as Record<string, unknown>;
  const rawHyper = Array.isArray(obj.hyperedges)
    ? obj.hyperedges
    : Array.isArray(graphAttrs.hyperedges)
      ? graphAttrs.hyperedges
      : [];
  const hyperedges: GraphifyHyperedge[] = [];
  for (const h of rawHyper as Array<Record<string, unknown>>) {
    const id = str(h?.id);
    const members = Array.isArray(h?.nodes) ? (h.nodes as unknown[]).map(str).filter((m) => ids.has(m)) : [];
    if (!id || members.length < 2) continue;
    hyperedges.push({
      id,
      label: str(h.label) || id,
      nodes: members,
      relation: str(h.relation) || 'form',
      confidenceScore: num01(h.confidence_score, 0.8),
      sourceFile: str(h.source_file),
    });
  }

  return { nodes, links, hyperedges };
}

// ── GRAPH_REPORT.md community labels ─────────────────────────────────────────

export interface CommunityLabel {
  label: string;
  cohesion?: number;
}

const PLACEHOLDER_LABEL = /^Module Group \d+$/;

/** Pull `### Community N - "Label"` (+ optional `Cohesion: x`) out of GRAPH_REPORT.md. */
export function parseCommunityLabels(reportText: string): Map<number, CommunityLabel> {
  const out = new Map<number, CommunityLabel>();
  const re = /^###\s+Community\s+(\d+)\s+-\s+"([^"\n]+)"\s*$/gm;
  for (let m = re.exec(reportText); m; m = re.exec(reportText)) {
    const key = Number(m[1]);
    const entry: CommunityLabel = { label: m[2].trim() };
    const tail = reportText.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const coh = /Cohesion:\s*([\d.]+)/.exec(tail);
    if (coh) entry.cohesion = Number(coh[1]);
    out.set(key, entry);
  }
  return out;
}

// ── selection: at most maxPerRepo nodes per repo ─────────────────────────────

export interface ExplainSubject {
  id: string; // brain node id
  kind: 'area' | 'god' | 'flow';
  title: string;
  members: string[]; // "Label (source_file)"
  relations: string[]; // "A -relation-> B" samples among members
}

export interface GraphifyImport {
  nodes: BrainNode[];
  edges: BrainEdge[];
  subjects: ExplainSubject[];
  perRepo: Record<string, { kept: number; total: number }>;
}

export interface IngestOptions {
  maxPerRepo?: number;
  graphPath?: string; // stored in graphifyRef.graph (relative to workspace root)
  now?: Date;
}

const AREA_SLOTS = 5;
const FLOW_SLOTS = 3;
const GOD_SLOTS = 2;
const MAX_CHILDREN = 40;
const CONTENT_MAX = 1200;

/** Top-level path segment = the repo a file belongs to ('(root)' for bare files). */
export function repoOfFile(sourceFile: string): string {
  const norm = sourceFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const i = norm.indexOf('/');
  return i > 0 ? norm.slice(0, i) : '(root)';
}

function majorityRepo(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (!f) continue;
    const r = repoOfFile(f);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = '(root)';
  let bestN = 0;
  for (const [r, n] of counts) {
    if (n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

function clip(text: string, max = CONTENT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function uniqueId(base: string, taken: Set<string>, fallbackSuffix: string): string {
  let id = base;
  if (taken.has(id)) id = slug(`${base}-${fallbackSuffix}`);
  let i = 2;
  while (taken.has(id)) id = slug(`${base}-${fallbackSuffix}-${i++}`);
  taken.add(id);
  return id;
}

interface Candidate {
  kind: 'area' | 'god' | 'flow';
  repo: string;
  rank: number; // lower = better, within its kind
  build: () => { node: BrainNode; subject: ExplainSubject };
}

/**
 * Compress a graphify graph into ≤ maxPerRepo brain nodes per repo:
 * up to 5 areas + 3 flows + 2 gods, unused slots backfilled with more areas.
 */
export function buildGraphifyImport(
  graph: GraphifyGraph,
  labels: Map<number, CommunityLabel>,
  options: IngestOptions = {},
): GraphifyImport {
  const maxPerRepo = Math.max(1, options.maxPerRepo ?? 10);
  const graphPath = options.graphPath ?? 'graphify-out/graph.json';
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Degrees: total (god ranking) and in-community (member ranking).
  const degree = new Map<string, number>();
  for (const l of graph.links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const members = new Map<number, GraphifyNode[]>();
  for (const n of graph.nodes) {
    if (n.community === null) continue;
    (members.get(n.community) ?? members.set(n.community, []).get(n.community)!).push(n);
  }
  for (const list of members.values()) list.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

  const communityRepo = new Map<number, string>();
  for (const [cid, list] of members) communityRepo.set(cid, majorityRepo(list.map((m) => m.sourceFile)));

  const takenIds = new Set<string>();
  const memberLine = (m: GraphifyNode): string => (m.sourceFile ? `${m.label} (${m.sourceFile})` : m.label);
  const relationSamples = (childIds: Set<string>, limit: number): string[] => {
    const out: string[] = [];
    for (const l of graph.links) {
      if (out.length >= limit) break;
      if (!childIds.has(l.source) || !childIds.has(l.target)) continue;
      out.push(`${byId.get(l.source)!.label} -${l.relation}-> ${byId.get(l.target)!.label}`);
    }
    return out;
  };

  const newNode = (
    id: string,
    title: string,
    category: BrainNode['category'],
    content: string,
    ref: GraphifyRef,
  ): BrainNode => ({
    id,
    title: title.slice(0, 80),
    category,
    content: clip(content),
    ...placeNode(category),
    origin: 'graphify',
    lastUpdated: nowIso,
    recallCount: 0,
    graphifyRef: ref,
  });

  // AREA candidates — one per community, real-label-first then by size.
  const realLabel = (cid: number): string | null => {
    const l = labels.get(cid)?.label;
    return l && !PLACEHOLDER_LABEL.test(l) ? l : null;
  };
  const communityIds = [...members.keys()].sort((a, b) => {
    const ra = realLabel(a) ? 0 : 1;
    const rb = realLabel(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (members.get(b)!.length ?? 0) - (members.get(a)!.length ?? 0);
  });

  const areaIdByCommunity = new Map<number, string>();
  const candidates: Candidate[] = [];

  communityIds.forEach((cid, rank) => {
    const list = members.get(cid)!;
    if (list.length < 2) return; // singleton communities carry no structure
    const label = realLabel(cid);
    const title = label ?? list.slice(0, 2).map((m) => m.label).join(' / ');
    const repo = communityRepo.get(cid)!;
    candidates.push({
      kind: 'area',
      repo,
      rank,
      build: () => {
        const id = uniqueId(`gf-area-${slug(title)}`, takenIds, String(cid));
        areaIdByCommunity.set(cid, id);
        const top = list.slice(0, 8);
        const dirs = [...new Set(list.map((m) => m.sourceFile).filter(Boolean).map((f) => repoOfFile(f)))].slice(0, 3);
        const cohesion = labels.get(cid)?.cohesion;
        const content = [
          `Codebase area in ${repo} (${list.length} entities${cohesion !== undefined ? `, cohesion ${cohesion}` : ''}).`,
          `Key parts: ${top.map(memberLine).join(', ')}.`,
          `↳ graphify community ${cid} — nff-brain expand ${id}`,
        ].join('\n');
        const children = list.slice(0, MAX_CHILDREN).map((m) => m.id);
        const childSet = new Set(children);
        return {
          node: newNode(id, title, 'analysis', content, { graph: graphPath, kind: 'community', key: cid, children }),
          subject: { id, kind: 'area', title, members: top.map(memberLine), relations: relationSamples(childSet, 6) },
        };
      },
    });
  });

  // GOD candidates — hub entities by total degree, attributed to their own file's repo.
  const gods = [...graph.nodes]
    .filter((n) => (degree.get(n.id) ?? 0) >= 3)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  gods.forEach((g, rank) => {
    const repo = g.sourceFile ? repoOfFile(g.sourceFile) : g.community !== null ? communityRepo.get(g.community)! : '(root)';
    candidates.push({
      kind: 'god',
      repo,
      rank,
      build: () => {
        const id = uniqueId(`gf-god-${slug(g.label)}`, takenIds, g.id);
        const neighbours: string[] = [];
        for (const l of graph.links) {
          const other = l.source === g.id ? l.target : l.target === g.id ? l.source : null;
          if (other && !neighbours.includes(other)) neighbours.push(other);
        }
        const top = neighbours.slice(0, 6).map((nid) => byId.get(nid)!.label);
        const content = [
          `Core abstraction in ${repo} (${degree.get(g.id) ?? 0} connections)${g.sourceFile ? `, defined in ${g.sourceFile}` : ''}.`,
          `Connects: ${top.join(', ')}.`,
          `↳ graphify node ${g.id} — nff-brain expand ${id}`,
        ].join('\n');
        const children = [g.id, ...neighbours.slice(0, MAX_CHILDREN - 1)];
        return {
          node: newNode(id, g.label, 'core', content, { graph: graphPath, kind: 'node', key: g.id, children }),
          subject: {
            id,
            kind: 'god',
            title: g.label,
            members: [memberLine(g), ...neighbours.slice(0, 6).map((nid) => memberLine(byId.get(nid)!))],
            relations: relationSamples(new Set(children), 6),
          },
        };
      },
    });
  });

  // FLOW candidates — named hyperedges by confidence then member count.
  const flows = [...graph.hyperedges].sort(
    (a, b) => b.confidenceScore - a.confidenceScore || b.nodes.length - a.nodes.length,
  );
  flows.forEach((h, rank) => {
    const files = h.nodes.map((nid) => byId.get(nid)?.sourceFile ?? '');
    const repo = majorityRepo(files.some(Boolean) ? files : [h.sourceFile]);
    candidates.push({
      kind: 'flow',
      repo,
      rank,
      build: () => {
        const id = uniqueId(`gf-flow-${slug(h.label)}`, takenIds, h.id);
        const memberNodes = h.nodes.map((nid) => byId.get(nid)!);
        const content = [
          `Flow/group in ${repo} (${h.relation}, ${h.nodes.length} members).`,
          `Members: ${memberNodes.slice(0, 8).map(memberLine).join(', ')}.`,
          `↳ graphify hyperedge ${h.id} — nff-brain expand ${id}`,
        ].join('\n');
        return {
          node: newNode(id, h.label, 'strategy', content, {
            graph: graphPath,
            kind: 'hyperedge',
            key: h.id,
            children: h.nodes.slice(0, MAX_CHILDREN),
          }),
          subject: {
            id,
            kind: 'flow',
            title: h.label,
            members: memberNodes.slice(0, 8).map(memberLine),
            relations: relationSamples(new Set(h.nodes), 6),
          },
        };
      },
    });
  });

  // Per-repo budget: 5 areas + 3 flows + 2 gods, backfill with areas.
  const byRepo = new Map<string, Candidate[]>();
  for (const c of candidates) (byRepo.get(c.repo) ?? byRepo.set(c.repo, []).get(c.repo)!).push(c);

  const nodes: BrainNode[] = [];
  const subjects: ExplainSubject[] = [];
  const perRepo: Record<string, { kept: number; total: number }> = {};
  const keptCommunities: number[] = [];

  for (const [repo, list] of byRepo) {
    const ranked = (kind: Candidate['kind']): Candidate[] =>
      list.filter((c) => c.kind === kind).sort((a, b) => a.rank - b.rank);
    const pools: Array<{ arr: Candidate[]; cap: number }> = [
      { arr: ranked('area'), cap: AREA_SLOTS },
      { arr: ranked('flow'), cap: FLOW_SLOTS },
      { arr: ranked('god'), cap: GOD_SLOTS },
    ];
    // Round-robin area→flow→god so a small budget still gets a mix of kinds,
    // honouring the per-kind slot caps; leftover slots backfill with more areas.
    const chosen: Candidate[] = [];
    for (let i = 0; i < Math.max(...pools.map((p) => p.cap)) && chosen.length < maxPerRepo; i++) {
      for (const { arr, cap } of pools) {
        if (chosen.length >= maxPerRepo) break;
        if (i < cap && arr[i]) chosen.push(arr[i]);
      }
    }
    for (const c of pools[0].arr.slice(AREA_SLOTS)) {
      if (chosen.length >= maxPerRepo) break;
      chosen.push(c);
    }
    perRepo[repo] = { kept: chosen.length, total: list.length };
    for (const c of chosen) {
      const { node, subject } = c.build();
      nodes.push(node);
      subjects.push(subject);
      if (node.graphifyRef?.kind === 'community') keptCommunities.push(node.graphifyRef.key as number);
    }
  }

  // Edges between imported nodes.
  const edges: BrainEdge[] = [];
  const importedAreas = new Set(keptCommunities);

  for (const n of nodes) {
    const ref = n.graphifyRef!;
    if (ref.kind === 'node') {
      const g = byId.get(String(ref.key));
      const areaId = g && g.community !== null ? areaIdByCommunity.get(g.community) : undefined;
      if (areaId) edges.push({ from: n.id, to: areaId, strength: 0.9 });
    } else if (ref.kind === 'hyperedge') {
      const h = graph.hyperedges.find((x) => x.id === ref.key);
      if (!h) continue;
      const communities = h.nodes.map((nid) => byId.get(nid)?.community).filter((c): c is number => c !== null && c !== undefined);
      const home = majorityCommunity(communities);
      const areaId = home !== null ? areaIdByCommunity.get(home) : undefined;
      if (areaId) edges.push({ from: n.id, to: areaId, strength: clampStrength(h.confidenceScore) });
    }
  }

  // area ↔ area: strongest cross-community links, top 2 partners per area.
  const cross = new Map<string, number>(); // "a b" (a<b) -> max score
  for (const l of graph.links) {
    const ca = byId.get(l.source)?.community;
    const cb = byId.get(l.target)?.community;
    if (ca === null || ca === undefined || cb === null || cb === undefined || ca === cb) continue;
    if (!importedAreas.has(ca) || !importedAreas.has(cb)) continue;
    const key = ca < cb ? `${ca} ${cb}` : `${cb} ${ca}`;
    cross.set(key, Math.max(cross.get(key) ?? 0, l.confidenceScore));
  }
  const partners = new Map<number, Array<{ other: number; score: number }>>();
  for (const [key, score] of cross) {
    const [a, b] = key.split(' ').map(Number);
    (partners.get(a) ?? partners.set(a, []).get(a)!).push({ other: b, score });
    (partners.get(b) ?? partners.set(b, []).get(b)!).push({ other: a, score });
  }
  const chosenPairs = new Set<string>();
  for (const [cid, list] of partners) {
    list.sort((a, b) => b.score - a.score);
    for (const { other } of list.slice(0, 2)) chosenPairs.add(cid < other ? `${cid} ${other}` : `${other} ${cid}`);
  }
  for (const key of chosenPairs) {
    const [a, b] = key.split(' ').map(Number);
    const fromId = areaIdByCommunity.get(a);
    const toId = areaIdByCommunity.get(b);
    if (fromId && toId) edges.push({ from: fromId, to: toId, strength: clampStrength(cross.get(key) ?? 0.6) });
  }

  return { nodes, edges, subjects, perRepo };
}

function majorityCommunity(communities: number[]): number | null {
  const counts = new Map<number, number>();
  for (const c of communities) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

// ── intent explanations (one batched LLM call, fail-open) ────────────────────

export function buildExplainPrompt(subjects: ExplainSubject[]): string {
  const entries = subjects.map((s) => {
    const lines = [`[${s.kind}] id="${s.id}" "${s.title}"`, `  members: ${s.members.join(', ')}`];
    if (s.relations.length) lines.push(`  relations: ${s.relations.join('; ')}`);
    return lines.join('\n');
  });
  return [
    `You are the graph explainer for a coding agent's memory. Below are high-level`,
    `entries imported from a code knowledge graph. For EACH entry, write 1-3 sentences`,
    `of CODE INTENT: what this part of the system is FOR, why it exists, and what an`,
    `agent should know before touching it. Do NOT restate the member list — capture`,
    `purpose and design intent in plain language.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{"explanations": {"<id>": "<1-3 sentences>"}}`,
    ``,
    `ENTRIES:`,
    entries.join('\n'),
  ].join('\n');
}

interface RawExplanations {
  explanations?: Record<string, unknown>;
}

/** Prepend LLM intent text to matching nodes' content. Returns how many applied. */
export function applyExplanations(nodes: BrainNode[], raw: string): number {
  const parsed = extractJson<RawExplanations>(raw);
  const map = parsed?.explanations;
  if (!map || typeof map !== 'object') return 0;
  let applied = 0;
  for (const n of nodes) {
    const text = map[n.id];
    if (typeof text !== 'string' || !text.trim()) continue;
    n.content = clip(`${text.trim()}\n${n.content}`);
    applied += 1;
  }
  return applied;
}

// ── apply to a brain (wholesale replace) + drill-down expansion ──────────────

/** Replace every existing graphify-origin node with the freshly imported set. */
export function applyGraphifyImport(
  brain: BrainFile,
  imported: { nodes: BrainNode[]; edges: BrainEdge[] },
): { removed: number; added: number } {
  const old = brain.nodes.filter((n) => n.origin === 'graphify').map((n) => n.id);
  for (const id of old) removeNode(brain, id);
  for (const n of imported.nodes) upsertNode(brain, n);
  for (const e of imported.edges) upsertEdge(brain, e);
  return { removed: old.length, added: imported.nodes.length };
}

export interface ExpandedRef {
  children: GraphifyNode[];
  internalLinks: GraphifyLink[];
  missing: number; // children ids no longer present in the graph (stale ref)
}

/** Resolve a brain node's graphifyRef against a freshly parsed graph. */
export function expandGraphifyRef(ref: GraphifyRef, graph: GraphifyGraph): ExpandedRef {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children: GraphifyNode[] = [];
  let missing = 0;
  for (const id of ref.children) {
    const n = byId.get(id);
    if (n) children.push(n);
    else missing += 1;
  }
  const childSet = new Set(children.map((c) => c.id));
  const internalLinks = graph.links.filter((l) => childSet.has(l.source) && childSet.has(l.target));
  return { children, internalLinks, missing };
}
