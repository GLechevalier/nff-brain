import type { BrainEdge, BrainFile, BrainNode } from './types.js';

// Pure in-memory graph operations, shared by recall / distill / merge / UI and
// the Chrome extension's standalone brain. NO node: imports — this module is a
// browser-safe subpath export (see package.json "exports" and the guards in
// test/webviewImports.test.ts). Persistence (fs, locking) stays in store.ts,
// which re-exports everything here so node callers are untouched.

export function upsertNode(brain: BrainFile, node: BrainNode): void {
  const i = brain.nodes.findIndex((n) => n.id === node.id);
  if (i >= 0) brain.nodes[i] = node;
  else brain.nodes.push(node);
}

/** Overwrite strength with the latest value (single-writer semantics, like the worker). */
export function upsertEdge(brain: BrainFile, edge: BrainEdge): void {
  const i = brain.edges.findIndex(
    (e) => (e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from),
  );
  if (i >= 0) brain.edges[i] = { ...brain.edges[i], strength: edge.strength };
  else brain.edges.push(edge);
}

export function removeNode(brain: BrainFile, id: string): boolean {
  const before = brain.nodes.length;
  brain.nodes = brain.nodes.filter((n) => n.id !== id);
  brain.edges = brain.edges.filter((e) => e.from !== id && e.to !== id);
  return brain.nodes.length < before;
}

export function nodeDegree(brain: BrainFile, id: string): number {
  return brain.edges.reduce((d, e) => d + (e.from === id || e.to === id ? 1 : 0), 0);
}

/** Merge project + global graphs for recall/UI. Project wins on id collision. */
export interface MergedBrain {
  nodes: BrainNode[];
  edges: BrainEdge[];
  /** Which file each node came from — mutations must route back to it. */
  sourceById: Map<string, 'project' | 'global'>;
}

export function mergeBrains(project: BrainFile | null, global: BrainFile | null): MergedBrain {
  const sourceById = new Map<string, 'project' | 'global'>();
  const nodes: BrainNode[] = [];
  for (const n of project?.nodes ?? []) {
    nodes.push(n);
    sourceById.set(n.id, 'project');
  }
  for (const n of global?.nodes ?? []) {
    if (!sourceById.has(n.id)) {
      nodes.push(n);
      sourceById.set(n.id, 'global');
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  const seenPair = new Set<string>();
  const edges: BrainEdge[] = [];
  for (const e of [...(project?.edges ?? []), ...(global?.edges ?? [])]) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue; // both endpoints must exist
    const key = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`;
    if (seenPair.has(key)) continue; // project edge wins (iterated first)
    seenPair.add(key);
    edges.push(e);
  }
  return { nodes, edges, sourceById };
}
