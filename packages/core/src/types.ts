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

export interface BrainNode {
  id: string; // kebab slug, ≤ 60 chars
  title: string; // ≤ 80 chars
  category: Category;
  content: string; // ≤ 1200 chars, actionable "When X, do Y because Z"
  color: string;
  x: number;
  y: number;
  size: number;
  // seed = init/user-authored (never auto-evicted)
  // graphify = imported codebase map (replaced wholesale on re-ingest, never folded)
  // import = mined from past Claude Code sessions (evictable and mergeable like agent)
  origin: 'seed' | 'agent' | 'graphify' | 'import';
  sourceSession?: string;
  lastUpdated: string; // ISO
  recallCount: number;
  lastRecalledAt?: string; // ISO
  graphifyRef?: GraphifyRef;
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
