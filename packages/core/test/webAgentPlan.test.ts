import { describe, expect, it } from 'vitest';
import {
  WEB_AGENT_MAX_ACTIONS_CEILING,
  buildLinkedInSearchUrl,
  buildPlanPrompt,
  clampMaxActions,
  decideNextAction,
  parsePlanResponse,
} from '../src/index.js';
import type { WebAgentRun } from '../src/index.js';

describe('clampMaxActions', () => {
  it('clamps to the hard ceiling regardless of what was requested', () => {
    expect(clampMaxActions(999)).toBe(WEB_AGENT_MAX_ACTIONS_CEILING);
  });

  it('floors at 1, never 0 or negative', () => {
    expect(clampMaxActions(0)).toBe(1);
    expect(clampMaxActions(-5)).toBe(1);
  });

  it('falls back to the ceiling on garbage input', () => {
    expect(clampMaxActions(NaN)).toBe(WEB_AGENT_MAX_ACTIONS_CEILING);
  });
});

describe('buildPlanPrompt', () => {
  it('opens with the registered marker and states the requested cap', () => {
    const p = buildPlanPrompt('find robotics engineers', { site: 'linkedin', maxActions: 5 });
    expect(p.startsWith('You are the web agent planner')).toBe(true);
    expect(p).toContain('At most 5 people');
    expect(p).toContain('find robotics engineers');
  });
});

describe('parsePlanResponse', () => {
  const params = { goal: 'find robotics engineers', site: 'linkedin' as const, maxActions: 5 };

  it('mints step ids by array position, never trusting a model-supplied id', () => {
    const plan = parsePlanResponse(
      JSON.stringify({
        steps: [
          { summary: 'search', verb: 'searchPeople', args: { query: 'robotics engineer' } },
          { summary: 'judge', verb: 'evaluateCards', args: {} },
        ],
        criteria: 'robotics engineer at a Series A startup',
      }),
      params,
    )!;
    expect(plan.steps.map((s) => s.id)).toEqual(['step-0', 'step-1']);
    expect(plan.steps[0].args.query).toBe('robotics engineer');
    expect(plan.criteria).toBe('robotics engineer at a Series A startup');
  });

  it('clamps maxActions server-side regardless of what the model echoed', () => {
    const doc = { steps: [{ summary: 's', verb: 'searchPeople', args: {} }] };
    const plan = parsePlanResponse(JSON.stringify(doc), { ...params, maxActions: 999 })!;
    expect(plan.maxActions).toBe(WEB_AGENT_MAX_ACTIONS_CEILING);
  });

  it('drops a step with an unknown verb, never the whole plan', () => {
    const plan = parsePlanResponse(
      JSON.stringify({
        steps: [
          { summary: 'bad', verb: 'deleteAccount', args: {} },
          { summary: 'ok', verb: 'searchPeople', args: {} },
        ],
      }),
      params,
    )!;
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].summary).toBe('ok');
  });

  it('returns null when nothing usable parsed', () => {
    expect(parsePlanResponse('total garbage', params)).toBeNull();
    expect(parsePlanResponse(JSON.stringify({ steps: [] }), params)).toBeNull();
  });
});

function baseRun(over: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: 'run_1',
    phase: 'running',
    clientId: 'cl_1',
    goal: 'find robotics engineers',
    plan: {
      goal: 'find robotics engineers',
      site: 'linkedin',
      criteria: 'robotics engineer',
      steps: [
        { id: 'step-0', summary: 'search', verb: 'searchPeople', args: { query: 'robotics engineer' } },
        { id: 'step-1', summary: 'judge', verb: 'evaluateCards', args: {} },
      ],
      maxActions: 5,
      createdAt: '2026-08-11T00:00:00.000Z',
    },
    listTarget: null,
    cursor: 0,
    pendingConnects: [],
    pendingConnectsStepId: null,
    actionsTaken: 0,
    maxActions: 5,
    nextAllowedAtMs: 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    history: [],
    ...over,
  };
}

describe('decideNextAction', () => {
  it('a queued clickConnect always wins over advancing the plan cursor', () => {
    const run = baseRun({
      cursor: 2,
      pendingConnects: [{ cardIndex: 3, name: 'Ada Lovelace', headline: 'Robotics Engineer' }],
      pendingConnectsStepId: 'step-1',
    });
    expect(decideNextAction(run)).toEqual({ stepId: 'step-1', verb: 'clickConnect', args: { cardIndex: '3' } });
  });

  it('a searchPeople step becomes a navigate action with a real LinkedIn search url', () => {
    const action = decideNextAction(baseRun())!;
    expect(action.stepId).toBe('step-0');
    expect(action.verb).toBe('navigate');
    expect(action.args.url).toBe(buildLinkedInSearchUrl('robotics engineer'));
  });

  it('an evaluateCards step becomes a readResultCards action', () => {
    const action = decideNextAction(baseRun({ cursor: 1 }))!;
    expect(action).toEqual({ stepId: 'step-1', verb: 'readResultCards', args: {} });
  });

  it('returns null once the plan is exhausted and nothing is queued', () => {
    expect(decideNextAction(baseRun({ cursor: 2 }))).toBeNull();
  });
});
