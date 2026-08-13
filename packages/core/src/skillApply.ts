// BRAIN-NODE.json ⇄ brain nodes. The build/apply split mirrors
// ingestGraphify.ts: expandSkillFile is PURE (it returns a plan and touches
// nothing), applySkillFile writes it into a brain under the caller's lock.
//
// Unlike applyGraphifyImport, apply is SCOPED TO ONE TREE rather than
// delete-every-imported-node-then-reinsert. Skill nodes accumulate learned
// state (recallCount, outcome) that a wholesale replace would silently reset —
// and preserving it across a re-import is exactly the "change only one specific
// part" property the format exists for.
//
// No `node:` imports.

import { removeNode, upsertEdge, upsertNode } from './brainGraph.js';
import { resolveRoot } from './spine.js';
import {
  placeNode,
  slug,
  type BrainEdge,
  type BrainFile,
  type BrainNode,
  type SkillRef,
} from './types.js';
import { SkillFileError, walkSteps, type SkillFile, type SkillStep } from './skillFile.js';

/** Skill nodes are always `strategy` — "a reusable procedure or playbook". */
const SKILL_CATEGORY = 'strategy' as const;
/**
 * Curated, not learned. `origin: 'seed'` is load-bearing: pruneBrain and
 * foldLeastUsed already exempt seeds from eviction, so the tree survives
 * consolidation without either of them needing to learn what a skill is.
 */
const SKILL_ORIGIN = 'seed' as const;

const CONTENT_MAX = 1200;
/** Parent→child. The strongest tier, so recall's EXPAND reaches the tree first. */
export const SKILL_EDGE_PARENT = 0.9;
/** Between consecutive alternatives, so they surface together in the graph. */
export const SKILL_EDGE_ALT = 0.5;
/** Root→hub, only when the root would otherwise be an island. */
export const SKILL_EDGE_HUB = 0.3;

export function skillRootId(tree: string): string {
  return slug(`sk-${tree}`);
}

export function skillStepId(tree: string, key: string): string {
  return slug(`sk-${tree}-${key}`);
}

// ── content composition ──────────────────────────────────────────────────────
// `when` / `verify` / `tags` live structurally in SkillRef, but scoreNode reads
// ONLY title and content (score.ts is frozen), so text that lives only in a
// machine field is invisible to retrieval. They are therefore mirrored into
// content as fixed-shape suffixes — and stripped back off on collapse by exact
// match, so the round trip is lossless rather than regex-guessed.

interface Derived {
  when?: string;
  verify?: string;
  tags?: string[];
}

function suffixes(d: Derived): string[] {
  const out: string[] = [];
  if (d.when) out.push(`\n\nWhen: ${d.when}`);
  if (d.verify) out.push(`\n\nVerify: ${d.verify}`);
  if (d.tags?.length) out.push(`\n\nTags: ${d.tags.join(', ')}`);
  return out;
}

function composeContent(base: string, d: Derived, where: string): string {
  const tail = suffixes(d).join('');
  if (base.length + tail.length > CONTENT_MAX) {
    throw new SkillFileError(
      `${where}: content plus its when/verify/tags is ${base.length + tail.length} chars, over the ${CONTENT_MAX} node limit. ` +
        `Shorten the content, or split this step into two.`,
    );
  }
  return base + tail;
}

/** Exact inverse of composeContent — peels known suffixes off the tail. */
export function stripDerived(content: string, d: Derived): string {
  let out = content;
  for (const s of suffixes(d).reverse()) {
    if (out.endsWith(s)) out = out.slice(0, -s.length);
  }
  return out;
}

// ── expand ───────────────────────────────────────────────────────────────────

export interface ExpandOptions {
  now?: Date;
  /** Where the file came from, relative to the workspace root. Informational. */
  source?: string;
  /**
   * The brain being written into, so a re-import can carry learned state and
   * board position forward. Pass the live nodes; nothing is mutated.
   */
  existing?: readonly BrainNode[];
}

export interface SkillExpansion {
  tree: string;
  nodes: BrainNode[];
  edges: BrainEdge[];
  rootId: string;
}

/** Laplace-smoothed success rate. Only meaningful once something was tried. */
export function skillConfidence(outcome: SkillRef['outcome']): number | undefined {
  if (!outcome || outcome.tried < 1) return undefined;
  return (outcome.worked + 1) / (outcome.tried + 2);
}

export function expandSkillFile(file: SkillFile, opts: ExpandOptions = {}): SkillExpansion {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const priorById = new Map((opts.existing ?? []).map((n) => [n.id, n]));
  const rootId = skillRootId(file.tree);

  const build = (
    id: string,
    title: string,
    baseContent: string,
    ref: SkillRef,
    derived: Derived,
    where: string,
  ): BrainNode => {
    const prior = priorById.get(id);
    // Carry learned state forward. A re-import must not reset what usage taught
    // us, or "edit one branch" would silently cost the whole tree its history.
    const outcome = prior?.skill?.outcome;
    if (outcome) ref.outcome = outcome;
    const node: BrainNode = {
      id,
      title: title.slice(0, 80),
      category: SKILL_CATEGORY,
      content: composeContent(baseContent, derived, where),
      // A refine keeps the node's place on the board; only new nodes get placed.
      ...(prior
        ? { color: prior.color, x: prior.x, y: prior.y, size: prior.size, laidOut: prior.laidOut }
        : placeNode(SKILL_CATEGORY)),
      origin: SKILL_ORIGIN,
      lastUpdated: nowIso,
      recallCount: prior?.recallCount ?? 0,
      lastRecalledAt: prior?.lastRecalledAt,
      skill: ref,
    };
    const conf = skillConfidence(outcome);
    if (conf !== undefined) node.confidence = conf;
    return node;
  };

  const nodes: BrainNode[] = [
    build(
      rootId,
      file.title,
      file.content,
      {
        tree: file.tree,
        path: [],
        kind: 'root',
        order: 0,
        ...(file.when ? { when: file.when } : {}),
        ...(file.verify ? { verify: file.verify } : {}),
        fileVersion: file.version,
        ...(opts.source ? { source: opts.source } : {}),
      },
      { when: file.when, verify: file.verify, tags: file.tags },
      `tree "${file.tree}"`,
    ),
  ];
  const edges: BrainEdge[] = [];

  walkSteps(file.steps, (step, path, order, parent) => {
    const id = skillStepId(file.tree, step.key);
    nodes.push(
      build(
        id,
        step.title,
        step.content,
        {
          tree: file.tree,
          path,
          kind: step.kind === 'alt' ? 'alt' : 'step',
          order,
          ...(step.when ? { when: step.when } : {}),
          ...(step.verify ? { verify: step.verify } : {}),
          ...(step.onFail?.length ? { onFail: step.onFail } : {}),
        },
        { when: step.when, verify: step.verify },
        `step "${step.key}"`,
      ),
    );
    const parentId = parent ? skillStepId(file.tree, parent.key) : rootId;
    edges.push({ from: parentId, to: id, strength: SKILL_EDGE_PARENT });
  });

  // Chain consecutive alternatives so a sibling run reads as a group on the
  // canvas. Preference order is carried by SkillRef.order/onFail, not by these.
  const chainAlts = (steps: readonly SkillStep[]): void => {
    const alts = steps.filter((s) => s.kind === 'alt');
    for (let i = 1; i < alts.length; i++) {
      edges.push({
        from: skillStepId(file.tree, alts[i - 1].key),
        to: skillStepId(file.tree, alts[i].key),
        strength: SKILL_EDGE_ALT,
      });
    }
    for (const s of steps) if (s.steps) chainAlts(s.steps);
  };
  chainAlts(file.steps);

  return { tree: file.tree, nodes, edges, rootId };
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface ApplySkillResult {
  created: string[];
  updated: string[];
  /** Nodes that belonged to this tree but are no longer in the file. */
  removed: string[];
  /**
   * Ids the file wants that are already held by something that is NOT part of
   * this tree. Non-empty ⇒ nothing was written unless `force`.
   */
  conflicts: Array<{ id: string; heldBy: string }>;
}

export function applySkillFile(
  brain: BrainFile,
  expansion: SkillExpansion,
  opts: { force?: boolean } = {},
): ApplySkillResult {
  const result: ApplySkillResult = { created: [], updated: [], removed: [], conflicts: [] };
  const byId = new Map(brain.nodes.map((n) => [n.id, n]));

  for (const n of expansion.nodes) {
    const prior = byId.get(n.id);
    if (prior && prior.skill?.tree !== expansion.tree) {
      result.conflicts.push({
        id: n.id,
        heldBy: prior.skill?.tree ? `skill tree "${prior.skill.tree}"` : `a ${prior.origin} node`,
      });
    }
  }
  // A curated file deserves an error, not importRoutes' silent -2/-3 remap:
  // the author chose these ids and needs to know one was already taken.
  if (result.conflicts.length > 0 && !opts.force) return result;

  // Scoped prune: steps this tree used to own but the file no longer declares.
  // Only ever touches nodes carrying THIS tree's marker.
  const wanted = new Set(expansion.nodes.map((n) => n.id));
  for (const n of brain.nodes.filter((x) => x.skill?.tree === expansion.tree && !wanted.has(x.id))) {
    result.removed.push(n.id);
  }
  for (const id of result.removed) removeNode(brain, id);

  for (const n of expansion.nodes) {
    if (byId.has(n.id)) result.updated.push(n.id);
    else result.created.push(n.id);
    upsertNode(brain, n);
  }
  for (const e of expansion.edges) upsertEdge(brain, e);

  // Tier 3, exactly as importApply/clipApply do it: hang an otherwise-orphaned
  // root off the graph's hub so the tree is reachable and never an island.
  //
  // The test is "does the root touch anything OUTSIDE this tree", not
  // nodeDegree === 0: a root always has its own children (a file with zero
  // steps is rejected at parse), so a degree check would never fire.
  const memberIds = new Set(expansion.nodes.map((n) => n.id));
  const reachesOutside = brain.edges.some(
    (e) =>
      (e.from === expansion.rootId && !memberIds.has(e.to)) ||
      (e.to === expansion.rootId && !memberIds.has(e.from)),
  );
  if (!reachesOutside) {
    const hub = resolveRoot(brain.nodes, brain.edges);
    if (hub && !memberIds.has(hub)) {
      upsertEdge(brain, { from: hub, to: expansion.rootId, strength: SKILL_EDGE_HUB });
    }
  }
  return result;
}

/** Re-emit a tree's edges from skill.path — the repair for a lost link line. */
export function relinkSkillTree(brain: BrainFile, tree: string): number {
  const members = brain.nodes.filter((n) => n.skill?.tree === tree);
  if (members.length === 0) return 0;
  const idByPath = new Map(members.map((n) => [(n.skill!.path ?? []).join(' '), n.id]));
  let n = 0;
  for (const node of members) {
    const path = node.skill!.path ?? [];
    if (path.length === 0) continue;
    const parentId = idByPath.get(path.slice(0, -1).join(' '));
    if (!parentId) continue; // dangling parent ⇒ treat as a root, never throw
    upsertEdge(brain, { from: parentId, to: node.id, strength: SKILL_EDGE_PARENT });
    n += 1;
  }
  return n;
}

// ── collapse ─────────────────────────────────────────────────────────────────

/**
 * Rebuild the authored file from the brain. Runtime state (recallCount,
 * outcome, geometry) is deliberately NOT exported — it is brain state, not
 * skill definition, and round-tripping it would make every export a diff.
 */
export function collapseSkillNodes(nodes: readonly BrainNode[], tree: string): SkillFile {
  const members = nodes.filter((n) => n.skill?.tree === tree);
  if (members.length === 0) throw new SkillFileError(`no skill tree "${tree}" in this brain`);
  const root = members.find((n) => n.skill!.kind === 'root');
  if (!root) throw new SkillFileError(`skill tree "${tree}" has no root node — re-import the file`);

  const tags = readTags(root.content);
  const file: SkillFile = {
    format: 'brain-node',
    version: 1,
    tree,
    title: root.title,
    content: stripDerived(root.content, {
      when: root.skill!.when,
      verify: root.skill!.verify,
      tags,
    }),
    steps: [],
  };
  if (root.skill!.when) file.when = root.skill!.when;
  if (root.skill!.verify) file.verify = root.skill!.verify;
  if (tags?.length) file.tags = tags;

  // Bucket by parent path, then recurse. Sibling order is SkillRef.order, with
  // id as a deterministic tie-break so export never depends on array order.
  const byParent = new Map<string, BrainNode[]>();
  for (const n of members) {
    const path = n.skill!.path ?? [];
    if (path.length === 0) continue;
    const key = path.slice(0, -1).join(' ');
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(n);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.skill!.order ?? 0) - (b.skill!.order ?? 0) || (a.id < b.id ? -1 : 1));
  }

  const buildLevel = (parentPath: string[]): SkillStep[] =>
    (byParent.get(parentPath.join(' ')) ?? []).map((n) => {
      const ref = n.skill!;
      const step: SkillStep = {
        key: ref.path[ref.path.length - 1],
        title: n.title,
        content: stripDerived(n.content, { when: ref.when, verify: ref.verify }),
      };
      if (ref.kind === 'alt') step.kind = 'alt';
      if (ref.when) step.when = ref.when;
      if (ref.verify) step.verify = ref.verify;
      if (ref.onFail?.length) step.onFail = [...ref.onFail];
      const kids = buildLevel(ref.path);
      if (kids.length) step.steps = kids;
      return step;
    });

  file.steps = buildLevel([]);
  return file;
}

/** Recover the authored tag list from the root's composed content. */
function readTags(content: string): string[] | undefined {
  const m = content.match(/\n\nTags: ([^\n]+)$/);
  if (!m) return undefined;
  const list = m[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}
