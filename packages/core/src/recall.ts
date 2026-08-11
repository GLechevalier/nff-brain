// The PRE-session read (GraphRAG retrieval), ported from the worker's
// brain/recall.ts. Pure over an in-memory graph: SEED the most relevant nodes
// lexically, EXPAND along the strongest edges, render the preamble the
// SessionStart hook prints to stdout. Small graphs (CLAUDE.md scale) skip
// retrieval entirely and inject everything — recall stays LLM-free and instant.

import { scoreNode, tokenize } from './score.js';
import type { BrainEdge, BrainNode } from './types.js';

export interface RecallOptions {
  k?: number; // seed nodes
  maxNodes?: number; // total nodes (seeds + neighbors)
  maxContentChars?: number; // per-node content trim in the preamble
  wholeGraphMax?: number; // graphs at/below this size are injected whole
  minScore?: number;
}

export interface RecallResult {
  preamble: string; // '' when nothing relevant was found
  nodes: BrainNode[]; // every included node (callers bump recallCount on these)
  seedCount: number; // nodes[0..seedCount) were lexical seeds; the rest are edge-expanded
}

const DEFAULTS: Required<RecallOptions> = {
  k: 6,
  maxNodes: 12,
  maxContentChars: 600,
  wholeGraphMax: 40,
  minScore: 0.05,
};

function trim(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function renderPreamble(included: BrainNode[], edges: BrainEdge[], maxContentChars: number): string {
  const titleById = new Map(included.map((n) => [n.id, n.title]));
  const relatedTitles = new Map<string, Set<string>>();
  for (const e of edges) {
    if (titleById.has(e.from) && titleById.has(e.to)) {
      (relatedTitles.get(e.from) ?? relatedTitles.set(e.from, new Set()).get(e.from)!).add(titleById.get(e.to)!);
      (relatedTitles.get(e.to) ?? relatedTitles.set(e.to, new Set()).get(e.to)!).add(titleById.get(e.from)!);
    }
  }

  const lines = included.map((n) => {
    const related = [...(relatedTitles.get(n.id) ?? [])];
    const rel = related.length ? `\n  ↳ related: ${related.join(', ')}` : '';
    // Codebase-map nodes advertise their drill-down so agents know the next hop.
    const expand = n.origin === 'graphify' ? ` (expand: nff-brain expand ${n.id})` : '';
    return `- [${n.category}] ${n.title}${expand}: ${trim(n.content, maxContentChars)}${rel}`;
  });

  const hasGraphify = included.some((n) => n.origin === 'graphify');
  const footer = hasGraphify
    ? `\nEntries marked "expand" are codebase-map nodes imported from graphify — run the ` +
      `command to list the underlying code entities and their files.\n`
    : '';

  return (
    `## Your learned skills & playbooks (recalled from this project's brain)\n` +
    `These are durable methods you distilled from earlier runs on THIS project. ` +
    `Apply the relevant ones as processes/checklists for the task below. If the task ` +
    `teaches something new, refines one of these, or one proves wrong, that will be ` +
    `captured automatically after the run — you do not need to record it yourself.\n\n` +
    `${lines.join('\n')}\n${footer}\n---\n`
  );
}

export function recallBrain(
  graph: { nodes: BrainNode[]; edges: BrainEdge[] },
  taskText: string,
  options: RecallOptions = {},
): RecallResult {
  const opts = { ...DEFAULTS, ...options };
  const { nodes, edges } = graph;
  if (nodes.length === 0) return { preamble: '', nodes: [], seedCount: 0 };

  // Whole-graph bypass: a CLAUDE.md-scale brain fits in context — inject it all.
  if (nodes.length <= opts.wholeGraphMax) {
    return {
      preamble: renderPreamble(nodes, edges, opts.maxContentChars),
      nodes: [...nodes],
      seedCount: nodes.length,
    };
  }

  // SEED — lexical ranking against the task text.
  const queryTokens = tokenize(taskText);
  const seeds = nodes
    .map((n) => ({ n, s: scoreNode(taskText, n, queryTokens) }))
    .filter((x) => x.s > opts.minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.k)
    .map((x) => x.n);
  if (seeds.length === 0) return { preamble: '', nodes: [], seedCount: 0 };

  // EXPAND — best neighbor per seed, ranked by edge strength, until the budget fills.
  const seedSet = new Set(seeds.map((n) => n.id));
  const touching = edges.filter((e) => seedSet.has(e.from) || seedSet.has(e.to));
  const neighborStrength = new Map<string, number>();
  for (const e of touching) {
    for (const end of [e.from, e.to]) {
      if (seedSet.has(end)) continue;
      neighborStrength.set(end, Math.max(neighborStrength.get(end) ?? 0, e.strength));
    }
  }
  const room = Math.max(0, opts.maxNodes - seeds.length);
  const neighborIds = new Set(
    [...neighborStrength.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, room)
      .map(([id]) => id),
  );
  const neighbors = nodes.filter((n) => neighborIds.has(n.id));
  const included = [...seeds, ...neighbors];

  return {
    preamble: renderPreamble(included, touching, opts.maxContentChars),
    nodes: included,
    seedCount: seeds.length,
  };
}

/** Mark recalled nodes as used — the value signal that keeps them from eviction. */
export function bumpRecall(brain: { nodes: BrainNode[] }, ids: string[], now = new Date()): void {
  const set = new Set(ids);
  for (const n of brain.nodes) {
    if (set.has(n.id)) {
      n.recallCount = (n.recallCount ?? 0) + 1;
      n.lastRecalledAt = now.toISOString();
    }
  }
}
