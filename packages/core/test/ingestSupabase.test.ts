import { describe, expect, it } from 'vitest';
import {
  applySupabaseImport,
  buildSupabaseImport,
  emptyBrain,
  rowNodeId,
  tableNodeId,
  upsertNode,
  type BrainNode,
  type SupabaseTableData,
} from '../src/index.js';

function fixtureTables(): SupabaseTableData[] {
  return [
    {
      table: 'crm_companies',
      columns: ['id', 'name'],
      primaryKey: 'id',
      foreignKeys: [],
      rows: [{ id: 'c1', name: 'Acme' }],
    },
    {
      table: 'crm_contacts',
      columns: ['id', 'name', 'company_id'],
      primaryKey: 'id',
      foreignKeys: [{ column: 'company_id', refTable: 'crm_companies', refColumn: 'id' }],
      rows: [
        { id: 'k1', name: 'Ada', company_id: 'c1' },
        { id: 'k2', name: 'Bo', company_id: null },
      ],
    },
  ];
}

describe('buildSupabaseImport', () => {
  it('builds a table master node per table and a row node per row', () => {
    const { nodes } = buildSupabaseImport(fixtureTables(), { source: 'test' });
    expect(nodes.find((n) => n.id === tableNodeId('crm_companies'))).toBeTruthy();
    expect(nodes.find((n) => n.id === tableNodeId('crm_contacts'))).toBeTruthy();
    expect(nodes.find((n) => n.id === rowNodeId('crm_contacts', 'k1'))?.title).toBe('Ada');
    expect(nodes.every((n) => n.origin === 'supabase')).toBe(true);
  });

  it('links row -> table-master, and exact FK matches row -> row', () => {
    const { edges } = buildSupabaseImport(fixtureTables(), { source: 'test' });
    expect(edges).toContainEqual(
      expect.objectContaining({ from: rowNodeId('crm_contacts', 'k1'), to: tableNodeId('crm_contacts') }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ from: rowNodeId('crm_contacts', 'k1'), to: rowNodeId('crm_companies', 'c1') }),
    );
    // k2's company_id is null — no FK edge for it.
    expect(edges.find((e) => e.from === rowNodeId('crm_contacts', 'k2') && e.to.startsWith('sb-row-crm-companies'))).toBeUndefined();
  });

  it('skips rows with no usable primary key value, without dropping the table master', () => {
    const tables = fixtureTables();
    tables[1].rows.push({ id: null, name: 'ghost', company_id: 'c1' });
    const { nodes } = buildSupabaseImport(tables, { source: 'test' });
    expect(nodes.filter((n) => n.id.startsWith('sb-row-crm-contacts'))).toHaveLength(2);
    expect(nodes.find((n) => n.id === tableNodeId('crm_contacts'))).toBeTruthy();
  });

  it('never dumps the full row into content — only a short synthesized label', () => {
    const tables: SupabaseTableData[] = [
      {
        table: 'wide',
        columns: ['id', 'blob'],
        primaryKey: 'id',
        foreignKeys: [],
        rows: [{ id: '1', blob: 'x'.repeat(5000) }],
      },
    ];
    const { nodes } = buildSupabaseImport(tables, { source: 'test' });
    const row = nodes.find((n) => n.id === rowNodeId('wide', '1'))!;
    expect(row.content.length).toBeLessThan(400);
  });
});

describe('applySupabaseImport', () => {
  it('replaces every existing supabase-origin node wholesale, leaving other origins untouched', () => {
    const brain = emptyBrain();
    const seed: BrainNode = {
      id: 'kept-seed',
      title: 'kept',
      category: 'core',
      content: 'curated',
      color: '#000',
      x: 0,
      y: 0,
      size: 16,
      origin: 'seed',
      lastUpdated: new Date(0).toISOString(),
      recallCount: 0,
    };
    upsertNode(brain, seed);

    const first = buildSupabaseImport(fixtureTables(), { source: 'test' });
    applySupabaseImport(brain, first);
    const firstCount = brain.nodes.filter((n) => n.origin === 'supabase').length;
    expect(firstCount).toBeGreaterThan(0);

    // Re-sync with one fewer row: old supabase nodes must be gone, not accumulated.
    const shrunk = fixtureTables();
    shrunk[1].rows = [shrunk[1].rows[0]];
    const second = buildSupabaseImport(shrunk, { source: 'test' });
    const { removed } = applySupabaseImport(brain, second);

    expect(removed).toBe(firstCount);
    expect(brain.nodes.filter((n) => n.origin === 'supabase')).toHaveLength(second.nodes.length);
    expect(brain.nodes.find((n) => n.id === 'kept-seed')).toBeTruthy();
    expect(brain.nodes.find((n) => n.id === rowNodeId('crm_contacts', 'k2'))).toBeUndefined();
  });
});
