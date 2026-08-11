import {
  DEFAULT_SEMANTIC_FLOOR,
  appendActivity,
  embedQuery,
  fuseRanked,
  queryVectors,
  resolveBrainPaths,
  resolveTransformers,
  topKBySim,
} from '@nff-brain/core';
import type { HybridHit, SimHit } from '@nff-brain/core';
import { fail, flagNum, parseArgs, type Args } from '../util.js';
import { loadMerged } from './nodes.js';

// `nff-brain search <query>` — rank nodes in the merged project + global view.
//
// Hybrid when the optional semantic tier is installed AND a vector sidecar
// exists: lexical relevance (score.ts) fused with embedding cosine by RRF
// (rank.ts). Otherwise identical to the pure-lexical behaviour it has always
// had — semantic is an upgrade, never a dependency.

type Mode = 'auto' | 'on' | 'off';

function mode(args: Args): Mode {
  if (args.flags.lexical === true) return 'off';
  if (args.flags.semantic === true) return 'on';
  const env = process.env.NFF_BRAIN_SEMANTIC;
  return env === 'on' || env === 'off' ? env : 'auto';
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function envWeights(): [number, number] | undefined {
  const raw = process.env.NFF_BRAIN_HYBRID_WEIGHTS;
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  return parts.length === 2 && parts.every((n) => Number.isFinite(n))
    ? [parts[0]!, parts[1]!]
    : undefined;
}

export async function cmdSearch(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const query = args.positional.join(' ').trim();
  if (!query) fail('usage: nff-brain search <query> [--limit 10] [--semantic|--lexical] [--explain]');
  const merged = loadMerged();
  if (merged.nodes.length === 0) {
    console.log('brain is empty — run `nff-brain init`');
    return;
  }
  const limit = flagNum(args, 'limit') ?? 10;
  const paths = resolveBrainPaths(process.cwd());
  const want = mode(args);

  const { hits, semantic, note } = await semanticHits(query, paths, limit, want);
  const ranked = fuseRanked(query, merged.nodes, hits, {
    limit,
    k: envNum('NFF_BRAIN_HYBRID_K', 60),
    weights: envWeights(),
    floor: envNum('NFF_BRAIN_SEMANTIC_FLOOR', DEFAULT_SEMANTIC_FLOOR),
  });

  if (ranked.length === 0) {
    console.log(`(no matches for "${query}")`);
    if (note) console.log(note);
    return;
  }
  appendActivity(paths.project, { kind: 'search', ids: ranked.map((r) => r.node.id) });
  print(ranked, semantic, args.flags.explain === true);
  if (note) console.log(note);
}

interface SemanticResult {
  hits: SimHit[] | null;
  semantic: boolean;
  note: string | null;
}

/** Embed the query and pull cosine candidates. Any failure ⇒ lexical, quietly. */
async function semanticHits(
  query: string,
  paths: ReturnType<typeof resolveBrainPaths>,
  limit: number,
  want: Mode,
): Promise<SemanticResult> {
  if (want === 'off') return { hits: null, semantic: false, note: null };

  const explicit = want === 'on';
  const rt = resolveTransformers();
  if (!rt.installed) {
    return {
      hits: null,
      semantic: false,
      note: explicit ? '(semantic requested but not installed — run `nff-brain semantic install`)' : null,
    };
  }
  const { vectors, mismatch } = queryVectors(paths);
  if (vectors.size === 0) {
    return {
      hits: null,
      semantic: false,
      note: explicit ? '(no vector index yet — run `nff-brain index`)' : null,
    };
  }
  const qv = await embedQuery(query);
  if (!qv) {
    return { hits: null, semantic: false, note: explicit ? '(query embedding failed — showing lexical results)' : null };
  }
  return {
    hits: topKBySim(qv, vectors, limit * 3),
    semantic: true,
    note: mismatch ? `(note: ${mismatch})` : null,
  };
}

function print(ranked: HybridHit<{ id: string; category: string; title: string }>[], semantic: boolean, explain: boolean): void {
  const width = Math.min(40, Math.max(...ranked.map((r) => r.node.id.length)) + 2);
  if (!semantic) {
    // Byte-identical to the pre-semantic output.
    for (const { node, fused } of ranked) {
      console.log(`${fused.toFixed(2)}  ${node.id.padEnd(width)} [${node.category}] ${node.title}`);
    }
    return;
  }
  // With fusion on, `fused` is an RRF value (~0.03) and means nothing to a
  // human. Show the two signals that produced the order instead.
  console.log(`lex   sem   ${'id'.padEnd(width)} node`);
  for (const { node, lexical, semantic: sim } of ranked) {
    const lex = lexical > 0 ? lexical.toFixed(2) : ' ·  ';
    const sem = sim > 0 ? sim.toFixed(2) : ' ·  ';
    console.log(`${lex.padEnd(6)}${sem.padEnd(6)}${node.id.padEnd(width)}[${node.category}] ${node.title}`);
  }
  if (explain) {
    console.log('\nlex = lexical relevance (token overlap + trigram, 0–1)');
    console.log(`sem = embedding cosine; on this model ~0.40 is unrelated, ≥${DEFAULT_SEMANTIC_FLOOR} is a real match`);
    console.log('order = reciprocal rank fusion of the two ranks, NOT a sum of these numbers');
    console.log('·   = that signal did not rank this node');
  }
}
