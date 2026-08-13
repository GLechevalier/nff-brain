// The Brain tab's Manual-mode chat — the pure prompt half. Deliberately asks
// for PLAIN PROSE, not JSON: a chat answer is not a structured-extraction
// task, and parsing prose out of JSON would only add a brittleness this
// doesn't need. The route trims the raw runClaude() output directly as the
// answer — see packages/cli/src/serve/chatRoutes.ts.
//
// Sources shown to the user are the nodes RETRIEVED for this prompt (computed
// by the caller via the same fuseRanked() /v1/search already uses), never a
// model self-reported citation — that would risk a hallucinated reference to
// a node that was never actually fed to the model.

import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import type { SkillRef } from './types.js';

export const CHAT_MESSAGE_MAX = 2000;
export const CHAT_HISTORY_TURNS_MAX = 6;
export const CHAT_HISTORY_TEXT_MAX = 400;
export const CHAT_NODE_EXCERPT_MAX = 400;
export const CHAT_ANSWER_MAX = 4000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatContextNode {
  id: string;
  title: string;
  content: string;
  /** Present only on BRAIN-NODE.json skill-tree nodes. */
  skill?: SkillRef;
}

export interface ChatPromptParams {
  message: string;
  /** Most recent first or last — order doesn't matter, buildChatPrompt re-sorts oldest-first for a natural read. */
  history: readonly ChatTurn[];
  nodes: readonly ChatContextNode[];
}

// ── skill trees ──────────────────────────────────────────────────────────────
// A skill is a TREE, and flattening it to one bullet per node — which is what
// nodeLine below does for ordinary notes — turns a procedure into N
// disconnected fragments and loses the one thing that makes it a skill: which
// steps are ALTERNATIVES to each other. So skill nodes get their own renderer.
//
// It lives here rather than in a new module because chatPrompt is already the
// "render brain nodes into a prompt" unit AND is already on both browser-safety
// allowlists (packages/chrome/test/bundlePurity.test.ts,
// packages/core/test/webviewImports.test.ts). recall.ts imports it from the
// node side. A new module would cost four coordinated guard edits for nothing.

export const SKILL_STEP_EXCERPT_MAX = 400;
/** Alternatives that are not the preferred one render as a one-line menu entry. */
export const SKILL_ALT_EXCERPT_MAX = 160;

export interface SkillGroup<T> {
  tree: string;
  root: T | null;
  steps: T[];
}

type SkillNodeLike = { title: string; content: string; skill?: SkillRef; confidence?: number };

/**
 * Group skill nodes by tree, root first, each level in sibling order.
 *
 * ALTERNATIVES ARE ORDERED BY MEASURED SUCCESS — `confidence` descending, then
 * the authored order. That single rule is the whole learning loop: a branch
 * that failed drops below its sibling and is offered second next time, and it
 * persists because it is stored on the node rather than in a session.
 */
export function groupSkillNodes<T extends SkillNodeLike>(nodes: readonly T[]): Array<SkillGroup<T>> {
  const byTree = new Map<string, T[]>();
  for (const n of nodes) {
    if (!n.skill?.tree) continue;
    const list = byTree.get(n.skill.tree) ?? byTree.set(n.skill.tree, []).get(n.skill.tree)!;
    list.push(n);
  }
  return [...byTree.entries()].map(([tree, list]) => ({
    tree,
    root: list.find((n) => n.skill!.kind === 'root') ?? null,
    steps: list.filter((n) => n.skill!.kind !== 'root'),
  }));
}

function pathKey(p: readonly string[] | undefined): string {
  return (p ?? []).join(' ');
}

function siblingOrder<T extends SkillNodeLike>(a: T, b: T): number {
  const ca = a.confidence;
  const cb = b.confidence;
  // Untried branches keep their authored position rather than sorting to either
  // extreme — an unmeasured branch is not evidence of anything.
  if (ca !== undefined && cb !== undefined && ca !== cb) return cb - ca;
  return (a.skill!.order ?? 0) - (b.skill!.order ?? 0);
}

function hitRate(n: SkillNodeLike): string {
  const o = n.skill?.outcome;
  if (!o || o.tried < 1) return '';
  return `   [worked ${o.worked}/${o.tried}]`;
}

function excerpt(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * One tree → one indented SKILL.md block.
 *
 * NEVER emits a node id, and resolves every `onFail` key to a sibling TITLE:
 * the standing contract (asserted in chatPrompt.test.ts) is that the model
 * never sees node ids, because a model given an id will cite nodes it was not
 * shown.
 */
export function renderSkillBlock<T extends SkillNodeLike>(group: SkillGroup<T>): string {
  const { root, steps } = group;
  if (!root && steps.length === 0) return '';

  const byParent = new Map<string, T[]>();
  const titleByKey = new Map<string, string>();
  for (const s of steps) {
    const path = s.skill!.path ?? [];
    if (path.length === 0) continue;
    titleByKey.set(path[path.length - 1], s.title);
    const key = pathKey(path.slice(0, -1));
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(s);
  }

  const lines: string[] = [];
  if (root) {
    lines.push(`### SKILL: ${root.title}`);
    if (root.skill?.when) lines.push(`Use when: ${root.skill.when}`);
    if (root.skill?.verify) lines.push(`Done when: ${root.skill.verify}`);
    const body = excerpt(stripTail(root.content), SKILL_STEP_EXCERPT_MAX);
    if (body) lines.push(body);
    lines.push('');
  }

  const pushBody = (n: T, indent: string, max: number): void => {
    const body = excerpt(stripTail(n.content), max);
    if (body) lines.push(`${indent}${body}`);
    if (n.skill?.verify) lines.push(`${indent}verify: ${n.skill.verify}`);
  };

  const render = (parentPath: string[], depth: number, prefix: string): void => {
    const kids = (byParent.get(pathKey(parentPath)) ?? []).slice().sort(siblingOrder);
    if (kids.length === 0) return;
    const indent = '  '.repeat(depth);

    let seq = 0; // sequential steps are numbered; alternatives are lettered
    let i = 0;
    while (i < kids.length) {
      if (kids[i].skill!.kind !== 'alt') {
        const n = kids[i];
        seq += 1;
        const label = `${prefix}${seq}`;
        lines.push(`${indent}${label}. ${n.title}${hitRate(n)}`);
        pushBody(n, `${indent}   `, SKILL_STEP_EXCERPT_MAX);
        render(n.skill!.path ?? [], depth + 1, `${label}.`);
        i += 1;
        continue;
      }

      // A run of alternatives — the "multiple ways to resolve a problem". They
      // are routes to the sub-problem their PARENT names, so they take the
      // parent's number with a letter suffix (2a, 2b, 2c).
      const run: T[] = [];
      while (i < kids.length && kids[i].skill!.kind === 'alt') run.push(kids[i++]);
      const base = prefix.replace(/\.$/, '');
      const keyOf = (n: T): string => (n.skill!.path ?? [])[(n.skill!.path ?? []).length - 1];
      const rank = new Map(run.map((n, k) => [keyOf(n), k]));
      lines.push(`${indent}— either of these, in this order —`);
      run.forEach((n, k) => {
        const label = `${base}${String.fromCharCode(97 + k)}`;
        lines.push(`${indent}  ${label}. ${n.title}${hitRate(n)}`);
        // Full body for the preferred route, a one-liner for the rest: the
        // fallbacks stay visible up front without burying the one that matters.
        pushBody(n, `${indent}     `, k === 0 ? SKILL_STEP_EXCERPT_MAX : SKILL_ALT_EXCERPT_MAX);
        // Only point FORWARD. `onFail` is authored, but the run is reordered by
        // measured success, so a hint at an alternative already offered above
        // would send the reader in a circle.
        const fallbacks = (n.skill!.onFail ?? [])
          .filter((key) => (rank.get(key) ?? -1) > k)
          .map((key) => titleByKey.get(key))
          .filter((t): t is string => !!t);
        if (fallbacks.length) {
          lines.push(`${indent}     if this fails, try: ${fallbacks.map((t) => `"${t}"`).join(' then ')}`);
        }
        render(n.skill!.path ?? [], depth + 2, `${label}.`);
      });
      lines.push('');
    }
  };

  render([], 1, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Drop the When:/Verify:/Tags: tail skillApply mirrors into content for
 * retrieval — it is rendered from SkillRef above, and repeating it verbatim
 * inside the body would say everything twice.
 */
function stripTail(content: string): string {
  return (content ?? '').replace(/\n\n(?:When|Verify|Tags): [^\n]*/g, '').trim();
}

/**
 * Turn a flat ranked hit list into whole skill trees plus the plain notes.
 *
 * A skill is split across ~10 nodes, so inside a shared top-8 it COMPETES WITH
 * ITSELF: one well-matched skill would take every slot, and a mid-tree fragment
 * could surface with no root to hang off. So a matching tree collapses to ONE
 * slot and is re-expanded from the full node set.
 *
 * Members are ordered ancestors-first (by path depth, then sibling order), so
 * the `maxNodesPerTree` slice can never orphan a step from its parent.
 *
 * Lives here rather than in recall.ts because the Chrome extension needs it and
 * `recall` is deliberately not on the browser-safe import allowlist.
 */
export function expandSkillHits<T extends SkillNodeLike & { id: string }>(
  all: readonly T[],
  hits: readonly T[],
  opts: { maxTrees?: number; maxNodesPerTree?: number } = {},
): { skills: T[]; plain: T[] } {
  // One tree by default: everything is a single user message with no system
  // slot, so prompt room is the scarce resource.
  const maxTrees = opts.maxTrees ?? 1;
  const maxNodesPerTree = opts.maxNodesPerTree ?? 8;

  const plain: T[] = [];
  const treesInRankOrder: string[] = [];
  for (const h of hits) {
    const tree = h.skill?.tree;
    if (!tree) {
      plain.push(h);
      continue;
    }
    if (!treesInRankOrder.includes(tree)) treesInRankOrder.push(tree);
  }

  const skills: T[] = [];
  for (const tree of treesInRankOrder.slice(0, maxTrees)) {
    const members = all
      .filter((n) => n.skill?.tree === tree)
      .sort(
        (a, b) =>
          (a.skill!.path ?? []).length - (b.skill!.path ?? []).length ||
          (a.skill!.order ?? 0) - (b.skill!.order ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );
    skills.push(...members.slice(0, maxNodesPerTree));
  }
  return { skills, plain };
}

export const SKILL_SECTION_HEADER = [
  `SKILLS YOU HAVE FOR THIS KIND OF TASK — a playbook written from earlier runs.`,
  `Follow the matching one as a checklist. Numbered entries are sequential steps;`,
  `entries under "— either of these —" are ALTERNATIVE routes to the SAME`,
  `sub-problem, listed best-first by how often each actually worked. If a step's`,
  `"verify" does not hold, do NOT keep pushing on it — drop to the next`,
  `alternative. Skip any step whose "Use when" plainly does not apply.`,
].join('\n');

function turnLine(t: ChatTurn): string {
  const who = t.role === 'user' ? 'User' : 'You';
  return `${who}: ${t.text.slice(0, CHAT_HISTORY_TEXT_MAX)}`;
}

function nodeLine(n: ChatContextNode, i: number): string {
  return `#${i} "${n.title}": ${n.content.slice(0, CHAT_NODE_EXCERPT_MAX)}`;
}

export function buildChatPrompt(params: ChatPromptParams): string {
  const history = params.history.slice(-CHAT_HISTORY_TURNS_MAX);
  const lines = [
    `${NFF_PROMPT_MARKERS.chat} for a coding agent's knowledge brain, talking directly with the person whose brain this is.`,
    ``,
    `Answer in plain prose — no JSON, no code fence, no preamble like "Based on your notes". If the notes below don't`,
    `actually answer the question, say so honestly rather than padding with generic advice.`,
    ``,
  ];
  // Skill trees render as procedures, ahead of the flat notes; everything else
  // goes through nodeLine exactly as before, so a prompt with no skill nodes is
  // byte-identical to what this built before skills existed.
  const plain = params.nodes.filter((n) => !n.skill?.tree);
  const blocks = groupSkillNodes(params.nodes)
    .map(renderSkillBlock)
    .filter((b) => b.length > 0);
  if (blocks.length > 0) {
    lines.push(SKILL_SECTION_HEADER, ``, ...blocks.flatMap((b) => [b, ``]));
  }
  if (plain.length > 0) {
    lines.push(`RELEVANT NOTES FROM THE BRAIN:`, ...plain.map(nodeLine), ``);
  } else if (blocks.length === 0) {
    lines.push(`(no notes in the brain matched this well enough to include)`, ``);
  }
  if (history.length > 0) {
    lines.push(`RECENT CONVERSATION:`, ...history.map(turnLine), ``);
  }
  lines.push(`QUESTION: ${params.message.slice(0, CHAT_MESSAGE_MAX)}`);
  return lines.join('\n');
}

/**
 * The prompt asks for plain prose, but the model doesn't always comply — this
 * strips the markdown it slips in anyway so the panel (plain textContent, no
 * renderer) never shows raw emphasis/code/header/bullet syntax. Order matters: fences first (so
 * code content isn't mangled by the later passes), bullets/headers next
 * (line-anchored, before bold/italic touch mid-line asterisks), then bold
 * before italic (else "**x**" would be left as "*x*" by the italic pass).
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```(?:\w*)?\n?([\s\S]*?)\n?```/g, '$1')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

export function cleanChatAnswer(raw: string): string {
  return stripMarkdown(raw.trim()).trim().slice(0, CHAT_ANSWER_MAX);
}
