// BRAIN-NODE.json — the transport/authoring unit of a skill tree.
//
// One file = one skill, held as a TREE of steps rather than the flat paragraph
// a BrainNode can carry. Two properties earn the format:
//
//   • `kind: 'alt'` siblings are INTERCHANGEABLE ways to solve the same
//     sub-problem. That is the thing a flat node cannot express, and the reason
//     an agent can fall back instead of failing.
//   • Every step expands into its own BrainNode, so one branch can be corrected
//     without rewriting the skill.
//
// Defensive parsing in the spirit of parseGraphifyGraph: this is a hand-edited
// file, so every failure throws a message that names the offending key rather
// than a TypeError from three frames down. No `node:` imports — the browser
// side reads these too.

import { SKILL_DEPTH_MAX, SKILL_KEY_MAX, SKILL_ONFAIL_MAX, SKILL_TREE_MAX, SKILL_WHEN_MAX, slug } from './types.js';

export const BRAIN_NODE_FORMAT = 'brain-node' as const;
export const BRAIN_NODE_VERSION = 1 as const;

export const SKILL_TITLE_MAX = 80;
export const SKILL_CONTENT_MAX = 1200;
export const SKILL_TAGS_MAX = 8;

/** One node of the tree, as it appears in the FILE. Children nest. */
export interface SkillStep {
  /**
   * Unique across the WHOLE tree, not merely among siblings. Global uniqueness
   * is what lets the derived brain id use the leaf key alone (`sk-<tree>-<key>`)
   * and still fit slug()'s 60-char cap without a disambiguating suffix — which
   * in turn is what makes re-import a deterministic upsert instead of a
   * duplicate.
   */
  key: string;
  title: string;
  /**
   * 'alt' marks a sibling as an ALTERNATIVE route to the same sub-problem
   * rather than the next sequential step. Default 'step'.
   */
  kind?: 'step' | 'alt';
  content: string;
  when?: string;
  verify?: string;
  /** Sibling keys to try instead, in preference order. */
  onFail?: string[];
  steps?: SkillStep[];
}

export interface SkillFile {
  format: typeof BRAIN_NODE_FORMAT;
  version: typeof BRAIN_NODE_VERSION;
  /** slug — the tree's identity and the id namespace for every step. */
  tree: string;
  title: string;
  /**
   * The root's content. THIS is the text scoreNode matches a task against, so
   * it must read as "when to reach for this skill" — the whole tree is admitted
   * or skipped on it.
   */
  content: string;
  when?: string;
  verify?: string;
  tags?: string[];
  steps: SkillStep[];
}

export class SkillFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFileError';
  }
}

function bad(msg: string): never {
  throw new SkillFileError(msg);
}

function str(v: unknown, where: string, max: number, required = true): string {
  if (v === undefined || v === null) {
    if (required) bad(`${where} is required`);
    return '';
  }
  if (typeof v !== 'string') bad(`${where} must be a string`);
  const t = v.trim();
  if (required && !t) bad(`${where} must not be empty`);
  if (t.length > max) bad(`${where} is ${t.length} chars, max ${max}`);
  return t;
}

function optStr(v: unknown, where: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v, where, max, false);
  return s || undefined;
}

/** Slug a key and prove the slug survived — an all-punctuation key is a typo, not an id. */
function keySlug(raw: string, where: string, max: number): string {
  const s = slug(raw);
  if (!s) bad(`${where} "${raw}" has no usable characters — ids are kebab slugs`);
  if (s.length > max) bad(`${where} "${raw}" slugs to ${s.length} chars, max ${max}`);
  return s;
}

interface ParseCtx {
  /** Every key seen anywhere in the tree → where, for a useful duplicate message. */
  seen: Map<string, string>;
}

function parseStep(raw: unknown, where: string, depth: number, ctx: ParseCtx): SkillStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${where} must be an object`);
  const o = raw as Record<string, unknown>;

  if (depth > SKILL_DEPTH_MAX) {
    bad(`${where} is nested ${depth} levels deep, max ${SKILL_DEPTH_MAX} — a deeper tree reads as a program, not a playbook`);
  }

  const key = keySlug(str(o.key, `${where}.key`, SKILL_KEY_MAX * 4), `${where}.key`, SKILL_KEY_MAX);
  const prior = ctx.seen.get(key);
  if (prior) bad(`duplicate step key "${key}" at ${where} — already used at ${prior}. Keys must be unique across the whole tree.`);
  ctx.seen.set(key, where);

  const kindRaw = o.kind;
  if (kindRaw !== undefined && kindRaw !== 'step' && kindRaw !== 'alt') {
    bad(`${where}.kind must be "step" or "alt"`);
  }

  const onFail = parseOnFail(o.onFail, `${where}.onFail`);

  const step: SkillStep = {
    key,
    title: str(o.title, `${where}.title`, SKILL_TITLE_MAX),
    content: str(o.content, `${where}.content`, SKILL_CONTENT_MAX),
  };
  if (kindRaw === 'alt') step.kind = 'alt';
  const when = optStr(o.when, `${where}.when`, SKILL_WHEN_MAX);
  if (when) step.when = when;
  const verify = optStr(o.verify, `${where}.verify`, SKILL_WHEN_MAX);
  if (verify) step.verify = verify;
  if (onFail.length) step.onFail = onFail;

  if (o.steps !== undefined) {
    if (!Array.isArray(o.steps)) bad(`${where}.steps must be an array`);
    const kids = (o.steps as unknown[]).map((k, i) => parseStep(k, `${where}.steps[${i}]`, depth + 1, ctx));
    if (kids.length) step.steps = kids;
  }
  return step;
}

function parseOnFail(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) bad(`${where} must be an array of sibling step keys`);
  if (raw.length > SKILL_ONFAIL_MAX) bad(`${where} lists ${raw.length} keys, max ${SKILL_ONFAIL_MAX}`);
  return raw.map((v, i) => keySlug(str(v, `${where}[${i}]`, SKILL_KEY_MAX * 4), `${where}[${i}]`, SKILL_KEY_MAX));
}

/**
 * Every onFail must name a SIBLING. Checked after the whole tree is parsed,
 * because a forward reference to a later sibling is legitimate and common
 * ("if this fails, try the next one down").
 */
function checkOnFailTargets(steps: readonly SkillStep[], where: string): void {
  const siblings = new Set(steps.map((s) => s.key));
  for (const s of steps) {
    for (const target of s.onFail ?? []) {
      if (target === s.key) bad(`${where}.${s.key}.onFail points at itself`);
      if (!siblings.has(target)) {
        bad(
          `${where}.${s.key}.onFail names "${target}", which is not a sibling. ` +
            `A fallback must be an alternative to the SAME sub-problem; siblings here are: ${[...siblings].join(', ')}`,
        );
      }
    }
    if (s.steps) checkOnFailTargets(s.steps, `${where}.${s.key}.steps`);
  }
}

export function parseSkillFile(jsonText: string): SkillFile {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    bad(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('the top level must be a JSON object');
  const o = doc as Record<string, unknown>;

  if (o.format !== BRAIN_NODE_FORMAT) {
    bad(`"format" must be "${BRAIN_NODE_FORMAT}" — this does not look like a BRAIN-NODE.json file`);
  }
  if (o.version !== BRAIN_NODE_VERSION) {
    bad(`"version" ${String(o.version)} is not supported by this build (expected ${BRAIN_NODE_VERSION})`);
  }

  const tree = keySlug(str(o.tree, 'tree', SKILL_TREE_MAX * 4), 'tree', SKILL_TREE_MAX);

  if (!Array.isArray(o.steps)) bad('"steps" must be an array');
  const ctx: ParseCtx = { seen: new Map() };
  const steps = (o.steps as unknown[]).map((s, i) => parseStep(s, `steps[${i}]`, 1, ctx));
  if (steps.length === 0) bad('"steps" must hold at least one step — a skill with no steps is a plain node');

  let tags: string[] | undefined;
  if (o.tags !== undefined && o.tags !== null) {
    if (!Array.isArray(o.tags)) bad('"tags" must be an array of strings');
    if (o.tags.length > SKILL_TAGS_MAX) bad(`"tags" has ${o.tags.length} entries, max ${SKILL_TAGS_MAX}`);
    const list = (o.tags as unknown[]).map((t, i) => str(t, `tags[${i}]`, 40));
    if (list.length) tags = list;
  }

  const file: SkillFile = {
    format: BRAIN_NODE_FORMAT,
    version: BRAIN_NODE_VERSION,
    tree,
    title: str(o.title, 'title', SKILL_TITLE_MAX),
    content: str(o.content, 'content', SKILL_CONTENT_MAX),
    steps,
  };
  const when = optStr(o.when, 'when', SKILL_WHEN_MAX);
  if (when) file.when = when;
  const verify = optStr(o.verify, 'verify', SKILL_WHEN_MAX);
  if (verify) file.verify = verify;
  if (tags) file.tags = tags;

  checkOnFailTargets(steps, 'steps');
  return file;
}

// ── serialization ────────────────────────────────────────────────────────────
// A FIXED key order, absent optionals omitted entirely (never `null`), and
// store.ts's two-space + trailing-newline convention. That is what makes
// `skill export` byte-stable and therefore diffable in review.

function orderStep(s: SkillStep): Record<string, unknown> {
  const out: Record<string, unknown> = { key: s.key, title: s.title };
  if (s.kind === 'alt') out.kind = 'alt';
  out.content = s.content;
  if (s.when) out.when = s.when;
  if (s.verify) out.verify = s.verify;
  if (s.onFail?.length) out.onFail = s.onFail;
  if (s.steps?.length) out.steps = s.steps.map(orderStep);
  return out;
}

export function serializeSkillFile(file: SkillFile): string {
  const out: Record<string, unknown> = {
    format: BRAIN_NODE_FORMAT,
    version: BRAIN_NODE_VERSION,
    tree: file.tree,
    title: file.title,
    content: file.content,
  };
  if (file.when) out.when = file.when;
  if (file.verify) out.verify = file.verify;
  if (file.tags?.length) out.tags = file.tags;
  out.steps = file.steps.map(orderStep);
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Depth-first walk in authored order, root excluded. */
export function walkSteps(
  steps: readonly SkillStep[],
  visit: (step: SkillStep, path: string[], order: number, parent: SkillStep | null) => void,
  parentPath: string[] = [],
  parent: SkillStep | null = null,
): void {
  steps.forEach((s, i) => {
    const path = [...parentPath, s.key];
    visit(s, path, i, parent);
    if (s.steps) walkSteps(s.steps, visit, path, s);
  });
}
