// Web agent planning — the pure prompt/parse half, modeled on clipDistill.ts.
// The model returns a bare, ordered array of steps; the server mints
// "step-<i>" ids by array position, exactly like clipDistill never trusts a
// model-supplied node id. maxActions is clamped server-side to a hard
// ceiling regardless of what the model echoes back — the cap is never
// model-controlled.

import { extractJson } from './distill.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import type { NextAction, PlanStep, PlanVerb, WebAgentPlan, WebAgentRun } from './webAgentTypes.js';

export const WEB_AGENT_MAX_ACTIONS_CEILING = 25;
export const WEB_AGENT_GOAL_MAX = 500;
export const WEB_AGENT_CRITERIA_MAX = 200;
export const WEB_AGENT_STEP_SUMMARY_MAX = 140;

const PLAN_VERBS: readonly PlanVerb[] = ['searchPeople', 'evaluateCards'];

export function clampMaxActions(requested: number): number {
  if (!Number.isFinite(requested)) return WEB_AGENT_MAX_ACTIONS_CEILING;
  return Math.max(1, Math.min(Math.floor(requested), WEB_AGENT_MAX_ACTIONS_CEILING));
}

export interface BuildPlanPromptOpts {
  site: 'linkedin';
  maxActions: number;
}

export function buildPlanPrompt(goal: string, opts: BuildPlanPromptOpts): string {
  const maxActions = clampMaxActions(opts.maxActions);
  return [
    `${NFF_PROMPT_MARKERS.agentPlanner} for a browser automation goal on ${opts.site}.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence):`,
    `{"steps":[{"summary":"<=${WEB_AGENT_STEP_SUMMARY_MAX} chars","verb":"searchPeople|evaluateCards","args":{}}],"criteria":"<=${WEB_AGENT_CRITERIA_MAX} chars"}`,
    ``,
    `Allowed verbs, and nothing else:`,
    `  searchPeople   — args:{"query":"<a ${opts.site} people-search query string>"}`,
    `  evaluateCards  — args:{} — this IS the judgment call: it means "read the`,
    `                   people found so far and decide which match". Follow every`,
    `                   searchPeople step with one evaluateCards step.`,
    ``,
    `"criteria" is the semantic filter a human would apply when deciding who`,
    `matches the goal — write it as a short, standalone sentence, since it will`,
    `be shown to a separate judgment pass that never sees this goal text again.`,
    ``,
    `Rules:`,
    `- At most ${maxActions} people will actually be contacted this run — say so in`,
    `  your step summaries, never promise more than that.`,
    `- Never invent a verb outside the two allowed above.`,
    `- Keep the plan short: a handful of steps, not one per expected candidate.`,
    ``,
    `GOAL: ${goal.slice(0, WEB_AGENT_GOAL_MAX)}`,
  ].join('\n');
}

interface RawPlanStep {
  summary?: unknown;
  verb?: unknown;
  args?: unknown;
}

function isPlanVerb(v: unknown): v is PlanVerb {
  return typeof v === 'string' && (PLAN_VERBS as readonly string[]).includes(v);
}

function readArgs(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export interface ParsePlanParams {
  goal: string;
  site: 'linkedin';
  maxActions: number;
  now?: Date;
}

/**
 * Tolerant like parseClipResponse: a missing array, a prose preamble, or a
 * step with an unknown verb costs that one step, never the whole plan.
 * Returns null only when nothing usable parsed at all.
 */
export function parsePlanResponse(raw: string, params: ParsePlanParams): WebAgentPlan | null {
  const doc = extractJson<Record<string, unknown>>(raw);
  if (!doc) return null;

  const rawSteps = Array.isArray(doc.steps) ? doc.steps : [];
  const steps: PlanStep[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== 'object') continue;
    const s = item as RawPlanStep;
    const summary = typeof s.summary === 'string' ? s.summary.trim() : '';
    if (!summary || !isPlanVerb(s.verb)) continue;
    steps.push({
      id: `step-${steps.length}`,
      summary: summary.slice(0, WEB_AGENT_STEP_SUMMARY_MAX),
      verb: s.verb,
      args: readArgs(s.args),
    });
  }
  if (steps.length === 0) return null;

  const criteria = typeof doc.criteria === 'string' ? doc.criteria.trim().slice(0, WEB_AGENT_CRITERIA_MAX) : '';

  return {
    goal: params.goal.slice(0, WEB_AGENT_GOAL_MAX),
    site: params.site,
    criteria,
    steps,
    maxActions: clampMaxActions(params.maxActions),
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

export const LINKEDIN_PEOPLE_SEARCH_URL = 'https://www.linkedin.com/search/results/people/';

export function buildLinkedInSearchUrl(query: string): string {
  return `${LINKEDIN_PEOPLE_SEARCH_URL}?keywords=${encodeURIComponent(query)}`;
}

/**
 * Pure, mechanical walk of a run's plan + queued matches — never touches an
 * LLM. A queued clickConnect (from the most recent evaluateCards' filter
 * call) always wins over advancing the plan cursor, and is drained one per
 * call so each still gets its own pacing delay and cap decrement.
 */
export function decideNextAction(run: WebAgentRun): NextAction | null {
  if (run.pendingConnects.length > 0) {
    const card = run.pendingConnects[0];
    return {
      stepId: run.pendingConnectsStepId ?? run.plan?.steps[run.cursor - 1]?.id ?? 'step-pending',
      verb: 'clickConnect',
      args: { cardIndex: String(card.cardIndex) },
    };
  }
  const step = run.plan?.steps[run.cursor];
  if (!step) return null;
  if (step.verb === 'searchPeople') {
    return { stepId: step.id, verb: 'navigate', args: { url: buildLinkedInSearchUrl(step.args.query ?? '') } };
  }
  return { stepId: step.id, verb: 'readResultCards', args: {} };
}
