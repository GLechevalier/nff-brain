// Import tables from a Postgres/Supabase database into the brain as SUPABASE
// nodes: one table-master node per included table plus one node per row,
// cross-linked by real foreign keys. Mirrors ingestGraphify.ts's contract
// exactly — a `supabaseRef` bridge back to the authoritative row instead of
// duplicating its content, origin 'supabase': never folded/evicted, replaced
// wholesale on re-ingest.
//
// Pure logic only (no `pg`, no `fs`) — the CLI command does the actual
// connecting/querying and hands this already-fetched plain objects, same split
// ingestGraphify.ts uses for file reads.

import { removeNode, upsertEdge, upsertNode } from './store.js';
import { placeNode, slug, type BrainEdge, type BrainFile, type BrainNode } from './types.js';

export interface SupabaseForeignKey {
  column: string; // local column holding the reference
  refTable: string;
  refColumn: string;
}

export interface SupabaseTableData {
  table: string;
  columns: string[];
  primaryKey?: string; // rows are skipped when a table has none — no stable id to upsert against
  foreignKeys: SupabaseForeignKey[]; // only FKs whose refTable is also being ingested matter here
  rows: Array<Record<string, unknown>>;
}

export interface SupabaseImportOptions {
  source: string; // short alias for the configured connection — never the connection string itself
  now?: Date;
}

export interface SupabaseImport {
  nodes: BrainNode[];
  edges: BrainEdge[];
}

const ROW_CONTENT_MAX = 300;
const TABLE_CONTENT_MAX = 1200;
const TABLE_CHILDREN_MAX = 200;
const LABEL_COLUMN_PRIORITY = ['title', 'name', 'label', 'email', 'username'];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, human-readable synthesis of a row — never the full row dumped verbatim. */
function labelRow(row: Record<string, unknown>, columns: string[]): string {
  for (const col of LABEL_COLUMN_PRIORITY) {
    const v = row[col];
    if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  const parts: string[] = [];
  for (const col of columns) {
    if (row[col] === null || row[col] === undefined) continue;
    parts.push(`${col}: ${row[col]}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(', ') : '(empty row)';
}

export function tableNodeId(table: string): string {
  return slug(`sb-table-${table}`);
}

export function rowNodeId(table: string, pk: string | number): string {
  return slug(`sb-row-${table}-${pk}`);
}

/** Build the node/edge set for a batch of already-fetched tables. Pure — no I/O. */
export function buildSupabaseImport(tables: readonly SupabaseTableData[], opts: SupabaseImportOptions): SupabaseImport {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];

  // Row nodes first, so FK edges below can resolve (table, pk) -> node id.
  const rowIdByKey = new Map<string, string>();
  const childrenByTable = new Map<string, string[]>();

  for (const t of tables) {
    const children: string[] = [];
    for (const row of t.rows) {
      const pk = t.primaryKey ? row[t.primaryKey] : undefined;
      if (pk === null || pk === undefined) continue; // no stable id — skip rather than invent one
      const rid = rowNodeId(t.table, pk as string | number);
      rowIdByKey.set(`${t.table}::${String(pk)}`, rid);
      children.push(rid);
      const label = labelRow(row, t.columns);
      nodes.push({
        id: rid,
        title: label.slice(0, 80),
        category: 'analysis',
        content: clip(label, ROW_CONTENT_MAX),
        ...placeNode('analysis'),
        origin: 'supabase',
        lastUpdated: nowIso,
        recallCount: 0,
        supabaseRef: { source: opts.source, table: t.table, kind: 'row', id: pk as string | number },
      });
      edges.push({ from: rid, to: tableNodeId(t.table), strength: 0.7 });
    }
    childrenByTable.set(t.table, children.slice(0, TABLE_CHILDREN_MAX));
  }

  // Table master nodes.
  for (const t of tables) {
    const content = `${t.rows.length} row(s) in ${t.table}. Columns: ${t.columns.join(', ')}.`;
    nodes.push({
      id: tableNodeId(t.table),
      title: t.table,
      category: 'core',
      content: clip(content, TABLE_CONTENT_MAX),
      ...placeNode('core'),
      origin: 'supabase',
      lastUpdated: nowIso,
      recallCount: 0,
      supabaseRef: { source: opts.source, table: t.table, kind: 'table', children: childrenByTable.get(t.table) ?? [] },
    });
  }

  // Exact FK edges between row nodes (ground truth, not inferred) + a tally of
  // how many FKs actually cross each pair of tables.
  const crossCount = new Map<string, number>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      for (const row of t.rows) {
        const localVal = row[fk.column];
        const pk = t.primaryKey ? row[t.primaryKey] : undefined;
        if (localVal === null || localVal === undefined || pk === null || pk === undefined) continue;
        const fromId = rowIdByKey.get(`${t.table}::${String(pk)}`);
        const toId = rowIdByKey.get(`${fk.refTable}::${String(localVal)}`);
        if (!fromId || !toId) continue; // referenced row wasn't ingested — skip, defensively
        edges.push({ from: fromId, to: toId, strength: 0.9 });
        const key = t.table < fk.refTable ? `${t.table} ${fk.refTable}` : `${fk.refTable} ${t.table}`;
        crossCount.set(key, (crossCount.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of crossCount) {
    const [a, b] = key.split(' ');
    edges.push({ from: tableNodeId(a), to: tableNodeId(b), strength: Math.min(0.9, 0.5 + count / 20) });
  }

  return { nodes, edges };
}

/** Replace every existing supabase-origin node with the freshly imported set. */
export function applySupabaseImport(
  brain: BrainFile,
  imported: { nodes: BrainNode[]; edges: BrainEdge[] },
): { removed: number; added: number } {
  const old = brain.nodes.filter((n) => n.origin === 'supabase').map((n) => n.id);
  for (const id of old) removeNode(brain, id);
  for (const n of imported.nodes) upsertNode(brain, n);
  for (const e of imported.edges) upsertEdge(brain, e);
  return { removed: old.length, added: imported.nodes.length };
}
