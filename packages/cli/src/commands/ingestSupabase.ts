import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import {
  applySupabaseImport,
  buildSupabaseImport,
  mutateBrain,
  resolveBrainPaths,
  supabaseConfigPath,
  type SupabaseForeignKey,
  type SupabaseTableData,
} from '@nff-brain/core';
import { refreshVectors } from '../semanticRefresh.js';
import { fail, flagNum, flagStr, parseArgs } from '../util.js';

// `nff-brain ingest-supabase list|sync` — attach to a Postgres/Supabase
// database, let the user choose which tables to pull context from, and mirror
// them into the brain as table-master + row nodes (see
// @nff-brain/core/ingestSupabase.ts for the node/edge shape).
//
// The connection string is NEVER persisted — only the table include/exclude
// list and row limit live in .nff-brain/supabase.json, beside brain.json.

const DEFAULT_ROW_LIMIT = 2000;
const LARGE_TABLE_ROWS = 5000;
const LOG_LIKE_NAME = /log|audit|event/i;
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SOURCE_ALIAS = 'supabase';

interface SupabaseSourceConfig {
  version: 1;
  include: string[];
  exclude: string[];
  rowLimit: number;
  lastSyncedAt?: string;
}

function loadConfig(cfgPath: string): SupabaseSourceConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<SupabaseSourceConfig>;
    return {
      version: 1,
      include: Array.isArray(raw.include) ? raw.include : [],
      exclude: Array.isArray(raw.exclude) ? raw.exclude : [],
      rowLimit: typeof raw.rowLimit === 'number' ? raw.rowLimit : DEFAULT_ROW_LIMIT,
      lastSyncedAt: raw.lastSyncedAt,
    };
  } catch {
    return { version: 1, include: [], exclude: [], rowLimit: DEFAULT_ROW_LIMIT };
  }
}

function saveConfig(cfgPath: string, cfg: SupabaseSourceConfig): void {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

function connectionString(args: ReturnType<typeof parseArgs>): string {
  const v = flagStr(args, 'conn') ?? process.env.NFF_BRAIN_SUPABASE_URL;
  if (!v) fail('missing connection string — pass --conn <url> or set NFF_BRAIN_SUPABASE_URL');
  return v;
}

async function listTables(client: Client): Promise<Array<{ table: string; estRows: number }>> {
  const res = await client.query<{ table_name: string; est_rows: string }>(
    `select c.relname as table_name, greatest(c.reltuples, 0)::bigint as est_rows
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`,
  );
  return res.rows.map((r) => ({ table: r.table_name, estRows: Number(r.est_rows) }));
}

async function tableColumns(client: Client, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

async function tablePrimaryKey(client: Client, table: string): Promise<string | undefined> {
  const res = await client.query<{ column_name: string }>(
    `select kcu.column_name from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'
     order by kcu.ordinal_position limit 1`,
    [table],
  );
  return res.rows[0]?.column_name;
}

async function tableForeignKeys(client: Client, table: string): Promise<SupabaseForeignKey[]> {
  const res = await client.query<{ column_name: string; ref_table: string; ref_column: string }>(
    `select kcu.column_name as column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
     join information_schema.constraint_column_usage ccu
       on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'FOREIGN KEY'`,
    [table],
  );
  return res.rows.map((r) => ({ column: r.column_name, refTable: r.ref_table, refColumn: r.ref_column }));
}

function splitList(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function cmdList(args: ReturnType<typeof parseArgs>): Promise<void> {
  const client = new Client({ connectionString: connectionString(args) });
  await client.connect();
  try {
    const tables = await listTables(client);
    for (const t of tables) {
      const large = t.estRows > LARGE_TABLE_ROWS;
      const logLike = LOG_LIKE_NAME.test(t.table);
      const verdict = large || logLike ? 'skip by default (large/log-like)' : 'includable';
      console.log(`${t.table}  ~${t.estRows} row(s)  ${verdict}`);
    }
    console.log(`\npick tables with: nff-brain ingest-supabase sync --conn ... --tables a,b,c`);
  } finally {
    await client.end();
  }
}

async function cmdSync(args: ReturnType<typeof parseArgs>, target: string, cfgPath: string): Promise<void> {
  const cfg = loadConfig(cfgPath);
  const rowLimit = flagNum(args, 'row-limit') ?? cfg.rowLimit;
  const exclude = flagStr(args, 'exclude') !== undefined ? splitList(flagStr(args, 'exclude')) : cfg.exclude;
  const requested = flagStr(args, 'tables') !== undefined ? splitList(flagStr(args, 'tables')) : cfg.include;
  if (requested.length === 0) {
    fail('no tables configured — run `nff-brain ingest-supabase list` first, then pass --tables a,b,c');
  }

  const client = new Client({ connectionString: connectionString(args) });
  await client.connect();
  try {
    const known = new Set((await listTables(client)).map((t) => t.table));
    const invalid = requested.filter((t) => !IDENTIFIER.test(t) || !known.has(t));
    if (invalid.length) fail(`unknown table(s): ${invalid.join(', ')}`);
    const include = requested.filter((t) => !exclude.includes(t));
    if (include.length === 0) fail('every requested table was excluded — nothing to sync');

    const tables: SupabaseTableData[] = [];
    for (const table of include) {
      const columns = await tableColumns(client, table);
      const primaryKey = await tablePrimaryKey(client, table);
      const foreignKeys = (await tableForeignKeys(client, table)).filter((fk) => include.includes(fk.refTable));
      // table/columns are validated above against information_schema — safe to interpolate the identifier.
      const res = await client.query(`select * from "${table}" limit $1`, [rowLimit]);
      tables.push({ table, columns, primaryKey, foreignKeys, rows: res.rows });
      if (!primaryKey) console.log(`  note: ${table} has no primary key — table node created, rows skipped`);
    }

    const imported = buildSupabaseImport(tables, { source: SOURCE_ALIAS });
    const { removed, added } = mutateBrain(target, (brain) => applySupabaseImport(brain, imported));
    saveConfig(cfgPath, { version: 1, include, exclude, rowLimit, lastSyncedAt: new Date().toISOString() });

    const vec = await refreshVectors(target);
    if (vec.ran) console.log(`re-embedded ${vec.embedded} node(s) for semantic search`);
    console.log(
      `synced ${tables.length} table(s), ${added} node(s) (+${imported.edges.length} edges); ` +
        `replaced ${removed} previous supabase node(s)`,
    );
  } finally {
    await client.end();
  }
}

export async function cmdIngestSupabase(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const cfgPath = supabaseConfigPath(target);

  if (sub === 'list') return cmdList(args);
  if (sub === 'sync') return cmdSync(args, target, cfgPath);
  fail('usage: nff-brain ingest-supabase <list|sync> [--conn url] [--tables a,b,c] [--exclude x,y] [--row-limit n]');
}
