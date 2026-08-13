// A WorkflowSpec is the generalized, replayable form of a recorded browser
// session (the "node chain / BRAIN-NODE" the user asked for). The distiller
// (workflowDistill.ts) turns a raw TraceRecord into one; it is stored as the
// structured payload of a single BrainNode (origin 'workflow'), and the web
// agent replays it by grounding each abstract step against the live page.
//
// What makes it GENERALIZABLE rather than a brittle macro:
//   - every literal the user typed/picked becomes a `param` (steps reference
//     {paramName}, the recorded value is kept only as an `example`);
//   - a repeated sub-sequence becomes ONE `loop` step with a `countParam`, not
//     N copies;
//   - each step's `intent` is site-agnostic; the site-specific evidence lives in
//     the `hint` (verbs + target descriptor + url pattern), used only to
//     re-resolve the target at replay time, never replayed as a fixed selector.
//
// Pure, node-free (browser-safe like trace.ts). Validation is tolerant/clamping
// because the distiller LLM's output is untrusted, exactly like clipDistill.

import type { TargetDescriptor } from './trace.js';
import { isVerbKind } from './browserVerbs.js';

export const WORKFLOW_VERSION = 1 as const;
export const MAX_WORKFLOW_PARAMS = 8;
export const MAX_WORKFLOW_STEPS = 20;
export const MAX_LOOP_BODY = 6;
export const MAX_INTENT = 200;
export const MAX_STEP_INTENT = 160;
export const MAX_SUCCESS = 200;
export const MAX_STEP_SUCCESS = 120;
export const MAX_PARAM_NAME = 30;
export const MAX_PARAM_DESC = 120;
export const MAX_PARAM_EXAMPLE = 200;

export interface WorkflowParam {
  /** camelCase knob the replayer binds, e.g. searchQuery, location, targetCount. */
  name: string;
  description: string;
  /** The value observed in the recording — a default/example, not a hardcode. */
  example: string;
  required: boolean;
}

export interface WorkflowStepHint {
  /** Verb ids from @nff-brain/core browserVerbs — what kind of action this is. */
  verbs?: string[];
  /** Recorded evidence for the target; a hint for re-grounding, never a selector. */
  target?: TargetDescriptor;
  /** e.g. "linkedin.com/search/results/people" — where this step happens. */
  urlPattern?: string;
}

export interface WorkflowStep {
  /** "step-<n>", minted from position by the applier — never the model's own id. */
  id: string;
  /** Site-agnostic, param-referencing, e.g. "open the next result's profile". */
  intent: string;
  hint?: WorkflowStepHint;
  /** Param names this step consumes. */
  params?: string[];
  /** A repeated sub-sequence: run `body` `countParam` (or over `over`) times. */
  loop?: { over: string; countParam?: string; body: WorkflowStep[] };
  /** Observable completion signal for this step. */
  success?: string;
}

export interface WorkflowSpec {
  v: typeof WORKFLOW_VERSION;
  /** Hostname the workflow was recorded on. */
  site: string;
  /** Generalized one-sentence goal. */
  intent: string;
  params: WorkflowParam[];
  steps: WorkflowStep[];
  successCriteria: string;
  sourceTraceId: string;
  recordedAt: string;
}

// ── validation ───────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function validParam(v: unknown): WorkflowParam | null {
  if (!isObj(v)) return null;
  const name = clampStr(v.name, MAX_PARAM_NAME).replace(/[^A-Za-z0-9_]/g, '');
  if (!name) return null;
  return {
    name,
    description: clampStr(v.description, MAX_PARAM_DESC),
    example: clampStr(v.example, MAX_PARAM_EXAMPLE),
    required: v.required !== false,
  };
}

function validVerbs(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => isVerbKind(x));
  return out.length ? out : undefined;
}

function validHint(v: unknown): WorkflowStepHint | undefined {
  if (!isObj(v)) return undefined;
  const hint: WorkflowStepHint = {};
  const verbs = validVerbs(v.verbs);
  if (verbs) hint.verbs = verbs;
  if (isObj(v.target) && typeof v.target.tag === 'string') hint.target = v.target as unknown as TargetDescriptor;
  const url = clampStr(v.urlPattern, 200);
  if (url) hint.urlPattern = url;
  return Object.keys(hint).length ? hint : undefined;
}

function validStep(v: unknown, id: string, depth: number): WorkflowStep | null {
  if (!isObj(v)) return null;
  const intent = clampStr(v.intent, MAX_STEP_INTENT);
  if (!intent) return null;
  const step: WorkflowStep = { id, intent };
  // The distiller emits verbs/target/urlPattern at the step level; a stored spec
  // nests them under `hint`. Accept either so re-validation round-trips.
  const hint = validHint(isObj(v.hint) ? v.hint : v);
  if (hint) step.hint = hint;
  if (Array.isArray(v.params)) {
    const params = v.params.filter((p): p is string => typeof p === 'string' && !!p).map((p) => clampStr(p, MAX_PARAM_NAME));
    if (params.length) step.params = params;
  }
  const success = clampStr(v.success, MAX_STEP_SUCCESS);
  if (success) step.success = success;
  // One level of nesting only — a loop body cannot itself contain a loop.
  if (depth === 0 && isObj(v.loop) && Array.isArray(v.loop.body)) {
    const over = clampStr(v.loop.over, 40);
    const body: WorkflowStep[] = [];
    for (const raw of v.loop.body.slice(0, MAX_LOOP_BODY)) {
      const s = validStep(raw, `${id}-${body.length + 1}`, depth + 1);
      if (s) body.push(s);
    }
    if (body.length) {
      step.loop = { over: over || 'items', body };
      const cp = clampStr(v.loop.countParam, MAX_PARAM_NAME).replace(/[^A-Za-z0-9_]/g, '');
      if (cp) step.loop.countParam = cp;
    }
  }
  return step;
}

/**
 * Validate + clamp an untrusted workflow object (a distiller result, an
 * imported node's payload, a hand-edited md block). Returns null when there's
 * no usable workflow (no steps). Never throws. `sourceTraceId`/`recordedAt` are
 * supplied by the caller (the trusted context), not the model.
 */
export function validateWorkflowSpec(
  input: unknown,
  ctx: { sourceTraceId: string; recordedAt: string; site: string },
): WorkflowSpec | null {
  if (!isObj(input)) return null;

  const params: WorkflowParam[] = [];
  if (Array.isArray(input.params)) {
    for (const raw of input.params.slice(0, MAX_WORKFLOW_PARAMS)) {
      const p = validParam(raw);
      if (p && !params.some((x) => x.name === p.name)) params.push(p);
    }
  }

  const steps: WorkflowStep[] = [];
  if (Array.isArray(input.steps)) {
    for (const raw of input.steps.slice(0, MAX_WORKFLOW_STEPS)) {
      const s = validStep(raw, `step-${steps.length + 1}`, 0);
      if (s) steps.push(s);
    }
  }
  if (!steps.length) return null;

  return {
    v: WORKFLOW_VERSION,
    site: clampStr(ctx.site, 200) || clampStr(input.site, 200) || 'unknown',
    intent: clampStr(input.intent, MAX_INTENT),
    params,
    steps,
    successCriteria: clampStr(input.successCriteria, MAX_SUCCESS),
    sourceTraceId: ctx.sourceTraceId,
    recordedAt: ctx.recordedAt,
  };
}

/** A human-readable numbered summary for a BrainNode's content field (≤1200). */
export function renderWorkflowContent(spec: WorkflowSpec): string {
  const lines: string[] = [];
  if (spec.intent) lines.push(spec.intent);
  if (spec.params.length) {
    lines.push('');
    lines.push('Parameters: ' + spec.params.map((p) => `${p.name} (e.g. ${p.example})`).join(', '));
  }
  lines.push('');
  lines.push('Steps:');
  let n = 1;
  for (const s of spec.steps) {
    lines.push(`${n}. ${s.intent}`);
    if (s.loop) {
      for (const b of s.loop.body) lines.push(`   - ${b.intent}`);
    }
    n++;
  }
  if (spec.successCriteria) {
    lines.push('');
    lines.push('Done when: ' + spec.successCriteria);
  }
  return lines.join('\n').slice(0, 1200);
}
