// The PRE-session read (GraphRAG retrieval), ported from the worker's
// brain/recall.ts. Pure over an in-memory graph: SEED the most relevant nodes
// lexically, EXPAND along the strongest edges, render the preamble the
// SessionStart hook prints to stdout. Small graphs (CLAUDE.md scale) skip
// retrieval entirely and inject everything — recall stays LLM-free and instant.

import { groupSkillNodes, renderSkillBlock, SKILL_SECTION_HEADER } from './chatPrompt.js';
import { scoreNode, tokenize } from './score.js';
import { isClipTierNode, isSkillNode, type BrainEdge, type BrainNode } from './types.js';

export interface RecallOptions {
  k?: number; // seed nodes
  maxNodes?: number; // total nodes (seeds + neighbors)
  maxContentChars?: number; // per-node content trim in the preamble
  wholeGraphMax?: number; // graphs at/below this size are injected whole
  minScore?: number;
  clipBudget?: number; // origin:'clip'/'pagevisit' nodes get their own slots (see recallBrain)
  skillBudget?: number; // BRAIN-NODE.json skill nodes get their own slots too
  skillTreeMax?: number; // no single tree may take the whole skill budget
}

export interface RecallResult {
  preamble: string; // '' when nothing relevant was found
  nodes: BrainNode[]; // every included node (callers bump recallCount on these)
  seedCount: number; // nodes[0..seedCount) were lexical seeds; the rest are edge-expanded
}

// Exported so the savings estimator can price a preamble line with the SAME
// content trim recall actually applies, instead of re-hardcoding 600.
export const RECALL_DEFAULTS: Required<RecallOptions> = {
  k: 6,
  maxNodes: 12,
  maxContentChars: 600,
  wholeGraphMax: 40,
  minScore: 0.05,
  // The first per-origin budget. Clip nodes never compete for the 12 agent
  // slots (unbudgeted clippings would crowd out the expensive session lessons)
  // and never take more than this many of their own.
  clipBudget: 3,
  // Skill trees ride their own budget for a sharper reason than clips do: a
  // skill is split across ~10 nodes, so inside the shared pool it COMPETES WITH
  // ITSELF and one well-matched skill would evict every other note in the
  // brain. Admission is per TREE, not per node. ~1 root + 7 steps.
  skillBudget: 8,
  skillTreeMax: 6,
};

function trim(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Choose which skill nodes ride this recall.
 *
 * Selection is BY TREE and all-or-nothing-ish: a tree is scored by its best
 * member, then admitted as a unit. Half a procedure is worse than none — a
 * model handed steps 2 and 4 of a five-step playbook will confidently do the
 * wrong thing — so a tree over `skillTreeMax` contributes its root plus its
 * best-scoring steps AND their ancestors, never a floating fragment.
 */
function selectSkillNodes(
  skills: readonly BrainNode[],
  taskText: string,
  queryTokens: Set<string>,
  opts: { minScore: number; skillBudget: number; skillTreeMax: number },
): BrainNode[] {
  if (skills.length === 0 || opts.skillBudget <= 0) return [];

  const byTree = new Map<string, BrainNode[]>();
  for (const n of skills) {
    const t = n.skill!.tree;
    (byTree.get(t) ?? byTree.set(t, []).get(t)!).push(n);
  }

  const scored = [...byTree.values()]
    .map((members) => {
      const scores = new Map(members.map((n) => [n.id, scoreNode(taskText, n, queryTokens)]));
      return { members, scores, best: Math.max(...scores.values()) };
    })
    .filter((t) => t.best > opts.minScore)
    .sort((a, b) => b.best - a.best);

  const out: BrainNode[] = [];
  for (const tree of scored) {
    const room = opts.skillBudget - out.length;
    if (room <= 0) break;
    const cap = Math.min(opts.skillTreeMax, room);
    if (cap <= 0) break;

    const byPath = new Map(tree.members.map((n) => [(n.skill!.path ?? []).join(' '), n]));
    const chosen = new Map<string, BrainNode>();
    const root = tree.members.find((n) => n.skill!.kind === 'root');
    if (root) chosen.set(root.id, root);

    // Add the best steps, each dragging in any ancestor it needs, so every
    // rendered step still hangs off something the reader has seen.
    const rest = tree.members
      .filter((n) => n.skill!.kind !== 'root')
      .sort((a, b) => (tree.scores.get(b.id) ?? 0) - (tree.scores.get(a.id) ?? 0));
    for (const step of rest) {
      if (chosen.size >= cap) break;
      const lineage: BrainNode[] = [];
      const path = step.skill!.path ?? [];
      for (let i = 1; i <= path.length; i++) {
        const anc = byPath.get(path.slice(0, i).join(' '));
        if (anc && !chosen.has(anc.id)) lineage.push(anc);
      }
      if (chosen.size + lineage.length > cap) continue; // would split the lineage
      for (const n of lineage) chosen.set(n.id, n);
    }
    // A tree that could not fit even its root plus one step says nothing useful.
    if (chosen.size < 2) continue;
    out.push(...chosen.values());
  }
  return out;
}

function renderPreamble(included: BrainNode[], edges: BrainEdge[], maxContentChars: number): string {
  // Skill nodes render as trees below, never as bullets — see renderSkillBlock.
  const skillNodes = included.filter(isSkillNode);
  const flat = skillNodes.length ? included.filter((n) => !isSkillNode(n)) : included;

  const titleById = new Map(flat.map((n) => [n.id, n.title]));
  const treeById = new Map(included.map((n) => [n.id, n.skill?.tree]));
  const relatedTitles = new Map<string, Set<string>>();
  for (const e of edges) {
    // An intra-tree edge would make every step list its parent and siblings as
    // "related", which says nothing the indentation didn't already say.
    const t = treeById.get(e.from);
    if (t && t === treeById.get(e.to)) continue;
    if (titleById.has(e.from) && titleById.has(e.to)) {
      (relatedTitles.get(e.from) ?? relatedTitles.set(e.from, new Set()).get(e.from)!).add(titleById.get(e.to)!);
      (relatedTitles.get(e.to) ?? relatedTitles.set(e.to, new Set()).get(e.to)!).add(titleById.get(e.from)!);
    }
  }

  const lines = flat.map((n) => {
    const related = [...(relatedTitles.get(n.id) ?? [])];
    const rel = related.length ? `\n  ↳ related: ${related.join(', ')}` : '';
    // Codebase-map nodes advertise their drill-down so agents know the next hop.
    const expand = n.origin === 'graphify' ? ` (expand: nff-brain expand ${n.id})` : '';
    // Browser captures tag as [clip]/[pagevisit] — the reader cares that it
    // came from a web page (with its source, and whether it was explicitly
    // saved or just visited), more than which category steered its edges.
    if (isClipTierNode(n)) {
      const from = hostOf(n.sourceUrl);
      const tag = n.origin === 'pagevisit' ? 'pagevisit' : 'clip';
      return `- [${tag}] ${n.title}: ${trim(n.content, maxContentChars)}${from ? ` (from ${from})` : ''}${rel}`;
    }
    return `- [${n.category}] ${n.title}${expand}: ${trim(n.content, maxContentChars)}${rel}`;
  });

  const hasGraphify = included.some((n) => n.origin === 'graphify');
  const footer = hasGraphify
    ? `\nEntries marked "expand" are codebase-map nodes imported from graphify — run the ` +
      `command to list the underlying code entities and their files.\n`
    : '';

  // Skill trees come after the bullets, as procedures. Rendered through the
  // same renderer the browser chat uses, so a skill reads identically wherever
  // it surfaces.
  const blocks = skillNodes.length
    ? groupSkillNodes(skillNodes)
        .map(renderSkillBlock)
        .filter((b) => b.length > 0)
    : [];
  const skillSection = blocks.length ? `\n${SKILL_SECTION_HEADER}\n\n${blocks.join('\n\n')}\n` : '';

  return (
    `## Your learned skills & playbooks (recalled from this project's brain)\n` +
    `These are durable methods you distilled from earlier runs on THIS project. ` +
    `Apply the relevant ones as processes/checklists for the task below. If the task ` +
    `teaches something new, refines one of these, or one proves wrong, that will be ` +
    `captured automatically after the run — you do not need to record it yourself.\n\n` +
    `${lines.join('\n')}\n${footer}${skillSection}\n---\n`
  );
}

export function recallBrain(
  graph: { nodes: BrainNode[]; edges: BrainEdge[] },
  taskText: string,
  options: RecallOptions = {},
): RecallResult {
  const opts = { ...RECALL_DEFAULTS, ...options };
  if (graph.nodes.length === 0) return { preamble: '', nodes: [], seedCount: 0 };

  // Clip nodes live on their own budget: they are PARTITIONED OUT before the
  // seed/expand pipeline (and before the whole-graph bypass — 60 buffered
  // clippings must never be injected wholesale into a small brain), then the
  // best few are appended after the agent slots are filled.
  const clips = graph.nodes.filter(isClipTierNode);
  // Skill-tree nodes are partitioned out for the same reason and one sharper
  // one: a skill is spread over ~10 nodes, so inside the shared pool it
  // competes with ITSELF and one match would evict the rest of the brain. It is
  // also why they must skip the whole-graph bypass — a 60-node skill library
  // injected wholesale into a small brain is exactly the hazard spine.ts warns
  // about. Admission happens per tree, below.
  const skills = graph.nodes.filter(isSkillNode);
  const held = clips.length || skills.length;
  const nodes = held ? graph.nodes.filter((n) => !isClipTierNode(n) && !isSkillNode(n)) : graph.nodes;
  const heldIds = new Set([...clips, ...skills].map((n) => n.id));
  const edges = held ? graph.edges.filter((e) => !heldIds.has(e.from) && !heldIds.has(e.to)) : graph.edges;

  const queryTokens = tokenize(taskText);
  const topClips = clips
    .map((n) => ({ n, s: scoreNode(taskText, n, queryTokens) }))
    .filter((x) => x.s > opts.minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.clipBudget)
    .map((x) => x.n);
  const topSkills = selectSkillNodes(skills, taskText, queryTokens, opts);

  // Whole-graph bypass: a CLAUDE.md-scale brain fits in context — inject it all.
  if (nodes.length <= opts.wholeGraphMax) {
    const included = [...nodes, ...topSkills, ...topClips];
    if (included.length === 0) return { preamble: '', nodes: [], seedCount: 0 };
    return {
      preamble: renderPreamble(included, graph.edges, opts.maxContentChars),
      nodes: included,
      seedCount: nodes.length,
    };
  }

  // SEED — lexical ranking against the task text.
  const seeds = nodes
    .map((n) => ({ n, s: scoreNode(taskText, n, queryTokens) }))
    .filter((x) => x.s > opts.minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.k)
    .map((x) => x.n);
  if (seeds.length === 0 && topClips.length === 0 && topSkills.length === 0) {
    return { preamble: '', nodes: [], seedCount: 0 };
  }
  if (seeds.length === 0) {
    // Nothing agent-side matched, but a skill or a browser capture did — inject
    // just those rather than nothing.
    const included = [...topSkills, ...topClips];
    return {
      preamble: renderPreamble(included, graph.edges, opts.maxContentChars),
      nodes: included,
      seedCount: 0,
    };
  }

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
  // Clips render last: seeds → neighbors → skills → clips, so the activity wave
  // order stays meaningful and neither displaces an agent line.
  const included = [...seeds, ...neighbors, ...topSkills, ...topClips];

  return {
    preamble: renderPreamble(included, graph.edges, opts.maxContentChars),
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
