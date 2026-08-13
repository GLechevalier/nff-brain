// Data model for the local brain — a JSON knowledge graph ported from the
// nff-agent-worker brain (brain_nodes / brain_edges) minus embeddings.

export const BRAIN_VERSION = 1 as const;

export const CATEGORIES = [
  'core',
  'analysis',
  'rules',
  'strategy',
  'decision',
  'preference',
  'task',
] as const;
export type Category = (typeof CATEGORIES)[number];

// One-line gloss per category, shown to the distiller/importer LLM. Without
// these, seven bare labels give the model no way to tell `decision` from
// `strategy` from `rules` and the categories drift into noise.
export const CATEGORY_HINTS: Record<Category, string> = {
  core: 'the project itself — what it is, its hub facts',
  analysis: 'a finding about how something works, incl. an approach that FAILED and why',
  rules: 'a hard constraint or invariant that must not be broken',
  strategy: 'a reusable procedure or playbook — "when X, do Y because Z"',
  decision: 'an architectural choice that was MADE and stuck, with its reason',
  preference: 'how THIS developer wants to work — style, tools, tone, habits',
  task: 'work explicitly deferred and still open',
};

// Same palette as the seed graph so nodes render consistently everywhere.
export const COLOR_BY_CATEGORY: Record<Category, string> = {
  core: '#00ffcc',
  strategy: '#a78bfa',
  analysis: '#22d3ee',
  rules: '#4ade80',
  decision: '#fbbf24',
  preference: '#f472b6',
  task: '#fb923c',
};

// First-class link from an imported codebase-map node down into the graphify
// knowledge graph it summarizes (graphify-out/graph.json).
export interface GraphifyRef {
  graph: string; // path to graph.json, relative to the workspace root
  kind: 'community' | 'node' | 'hyperedge';
  key: string | number; // community int, or graphify node/hyperedge id
  children: string[]; // graphify node ids this brain node summarizes
}

/**
 * A node's place in a SKILL TREE imported from a BRAIN-NODE.json file.
 *
 * The tree lives HERE and not in edges, because edges are effectively
 * UNDIRECTED: upsertEdge (brainGraph.ts) matches (from,to) in either direction
 * and overwrites, so a parent→child and a child→parent write COLLIDE, and
 * mergeBrains dedups on the unordered pair. Edges are still emitted for the
 * tree, but only for layout and recall expansion — losing one costs a visual
 * link, never the structure.
 *
 * Unlike spine.ts's derived `spine:` nodes, these ARE persisted: they hold real
 * knowledge. The hazards spine.ts's header lists are handled explicitly — see
 * recall.ts (own budget, whole-tree admission) and mergePass.ts (isSkillNode
 * gates).
 */
export interface SkillRef {
  /** slug of the tree — the identity of the BRAIN-NODE.json file. */
  tree: string;
  /**
   * Step keys from the root down to and including this node; [] on the root.
   * AUTHORITATIVE nesting — a parent is derived by looking up
   * (tree, path.slice(0,-1)), never stored twice.
   */
  path: string[];
  kind: 'root' | 'step' | 'alt';
  /** Index among siblings — what makes export byte-stable. */
  order: number;
  /** Machine fields. Absent ⇒ the node reads as prose and nothing is lost. */
  when?: string;
  verify?: string;
  /** Sibling step KEYS to try instead, in preference order. */
  onFail?: string[];
  /**
   * Learned outcome counters, written only from OBSERVED results (a tool
   * outcome, a user verdict) — never from a model's self-report, which would
   * inflate the confidence that reorders the alternatives.
   */
  outcome?: { tried: number; worked: number; failed: number; lastAt?: string };
  /** Root only. */
  fileVersion?: number;
  source?: string;
}

export interface BrainNode {
  id: string; // kebab slug, ≤ 60 chars
  title: string; // ≤ 80 chars
  category: Category;
  content: string; // ≤ 1200 chars, actionable "When X, do Y because Z"
  color: string;
  x: number;
  y: number;
  size: number;
  // True once a layout pass has settled this position. New nodes lack it, which
  // is how the incremental layout tells "seed me next to my neighbours" from
  // "leave me exactly where I am". Optional, so old brains load untouched.
  laidOut?: boolean;
  // seed = init/user-authored (never auto-evicted)
  // graphify = imported codebase map (replaced wholesale on re-ingest, never folded)
  // import = mined from past Claude Code sessions (evictable and mergeable like agent)
  // clip = distilled from a browser capture (own cap MAX_CLIP_NODES, own recall
  //        budget, never merged/folded — must stay retractable from the extension)
  origin: 'seed' | 'agent' | 'graphify' | 'import' | 'clip';
  sourceSession?: string;
  // http(s) page the clip was captured from (origin 'clip' only).
  sourceUrl?: string;
  lastUpdated: string; // ISO
  recallCount: number;
  lastRecalledAt?: string; // ISO
  graphifyRef?: GraphifyRef;
  // Place in a BRAIN-NODE.json skill tree. Absent on every ordinary node.
  skill?: SkillRef;
  // How sure we are this is durable knowledge. Set by the history importer
  // (LLM-proposed, then adjusted by heuristics and boosted when the same lesson
  // surfaces in several sessions). Absent on nodes written before/outside import.
  confidence?: number; // 0..1
  importedFrom?: string[]; // sessionIds this node was distilled from (≤5)
}

export interface BrainEdge {
  from: string;
  to: string;
  strength: number; // 0..1
}

export interface BrainFile {
  version: typeof BRAIN_VERSION;
  updatedAt: string; // ISO — cheap change detection for watchers
  nodes: BrainNode[];
  edges: BrainEdge[];
}

export function emptyBrain(now = new Date()): BrainFile {
  return { version: BRAIN_VERSION, updatedAt: now.toISOString(), nodes: [], edges: [] };
}

// ── skill trees (BRAIN-NODE.json) ────────────────────────────────────────────
// Caps live here, beside the type, so skillFile.ts's validator and skillApply's
// id minting can never disagree about them.

/** Tree slug ceiling. `sk-` + 32 + `-` + 20 = 56, inside slug()'s 60. */
export const SKILL_TREE_MAX = 32;
/** Step key ceiling — see SKILL_TREE_MAX for why these two numbers pair. */
export const SKILL_KEY_MAX = 20;
/** Levels of nesting below the root. Deeper reads as a program, not a playbook. */
export const SKILL_DEPTH_MAX = 4;
/** `when` / `verify` ceiling. */
export const SKILL_WHEN_MAX = 200;
/** Sibling keys one step may list in onFail. */
export const SKILL_ONFAIL_MAX = 4;

/**
 * The ONE predicate every skill gate uses, so they can never drift apart.
 * Deliberately not `origin === 'skill'`: skill nodes are curated, so they carry
 * origin 'seed' and inherit its existing eviction exemptions for free.
 */
export function isSkillNode(n: { skill?: SkillRef }): boolean {
  return !!n.skill?.tree;
}

export function asCategory(v: unknown): Category {
  return (CATEGORIES as readonly string[]).includes(v as string) ? (v as Category) : 'strategy';
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function clampStrength(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// New nodes get a random in-canvas position; the UI's overlap-relaxation pass
// (brainSpacing) untangles collisions, so an exact placement doesn't matter.
export function placeNode(category: Category): Pick<BrainNode, 'color' | 'x' | 'y' | 'size'> {
  return {
    color: COLOR_BY_CATEGORY[category],
    x: 120 + Math.random() * 560,
    y: 100 + Math.random() * 400,
    size: category === 'core' ? 32 : 16,
  };
}
