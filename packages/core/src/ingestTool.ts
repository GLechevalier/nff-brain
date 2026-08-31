// Import connected external tools/services into the brain as TOOL nodes: one
// master node per tool, no rows to enumerate (unlike ingestSupabase.ts's
// tables). Mirrors ingestSupabase.ts's contract — origin 'tool': never
// folded/evicted, replaced wholesale on re-ingest.
//
// Pure logic only (no I/O) — a future CLI command or caller fetches the
// actual connected-tool list (e.g. from an MCP config) and hands it here
// already-shaped as ToolInput[].

import { removeNode, upsertEdge, upsertNode } from './store.js';
import { placeNode, slug, type BrainEdge, type BrainFile, type BrainNode } from './types.js';

export interface ToolInput {
  id: string; // stable id, e.g. 'github', 'stripe' — never a secret/connection string
  label: string;
}

export interface ToolImportOptions {
  now?: Date;
}

export interface ToolImport {
  nodes: BrainNode[];
  edges: BrainEdge[];
}

const TOOL_CONTENT_MAX = 300;

export function toolNodeId(toolId: string): string {
  return slug(`tool-${toolId}`);
}

/** Build one master node per connected tool. Pure — no I/O. */
export function buildToolImport(tools: readonly ToolInput[], opts: ToolImportOptions = {}): ToolImport {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const nodes: BrainNode[] = [];

  for (const t of tools) {
    nodes.push({
      id: toolNodeId(t.id),
      title: t.label,
      category: 'core',
      content: `Connected tool: ${t.label}`.slice(0, TOOL_CONTENT_MAX),
      ...placeNode('core'),
      origin: 'tool',
      lastUpdated: nowIso,
      recallCount: 0,
      toolRef: { tool: t.id, label: t.label, kind: 'connection' },
    });
  }

  return { nodes, edges: [] };
}

/** Replace every existing tool-origin node with the freshly imported set. */
export function applyToolImport(brain: BrainFile, imported: ToolImport): { removed: number; added: number } {
  const old = brain.nodes.filter((n) => n.origin === 'tool').map((n) => n.id);
  for (const id of old) removeNode(brain, id);
  for (const n of imported.nodes) upsertNode(brain, n);
  for (const e of imported.edges) upsertEdge(brain, e);
  return { removed: old.length, added: imported.nodes.length };
}
