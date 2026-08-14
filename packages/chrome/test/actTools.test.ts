import { describe, expect, it } from 'vitest';
import {
  ACT_STEERING,
  buildActSystemPrompt,
  buildActUserGoal,
  buildPairedActPrompt,
  buildSessionStepMessage,
  buildSteeringPrompt,
  buildWorkflowRunPrompt,
  parseActAction,
  renderActContract,
} from '../src/actTools.js';
import type { WorkflowSpec } from '@nff-brain/core/workflow';

describe('parseActAction', () => {
  it('parses a single JSON action with args', () => {
    expect(parseActAction('{"action":"read_page","args":{"mode":"interactive"}}')).toEqual({
      kind: 'action',
      name: 'read_page',
      args: { mode: 'interactive' },
    });
  });

  it('defaults args to an empty object', () => {
    expect(parseActAction('{"action":"navigate"}')).toEqual({ kind: 'action', name: 'navigate', args: {} });
  });

  it('recognizes a done signal (done:true or action:done)', () => {
    expect(parseActAction('{"done":true,"summary":"clicked Get Started"}')).toEqual({
      kind: 'done',
      summary: 'clicked Get Started',
    });
    expect(parseActAction('{"action":"done","summary":"finished"}')).toEqual({ kind: 'done', summary: 'finished' });
  });

  it('tolerates prose around the JSON (claude -p is chatty)', () => {
    const out = parseActAction('Sure, here is my next action:\n```json\n{"action":"pointer","args":{"action":"click","ref":"e3"}}\n```');
    expect(out).toEqual({ kind: 'action', name: 'pointer', args: { action: 'click', ref: 'e3' } });
  });

  it('returns invalid when there is no usable JSON action', () => {
    expect(parseActAction('I think we should click the button.')).toEqual({ kind: 'invalid' });
    expect(parseActAction('{"foo":1}')).toEqual({ kind: 'invalid' });
  });

  it('parses a tabs action (list, switch, open, close, duplicate)', () => {
    expect(parseActAction('{"action":"tabs","args":{"action":"list"}}')).toEqual({
      kind: 'action',
      name: 'tabs',
      args: { action: 'list' },
    });
    expect(parseActAction('{"action":"tabs","args":{"action":"switch","tabId":42}}')).toEqual({
      kind: 'action',
      name: 'tabs',
      args: { action: 'switch', tabId: 42 },
    });
  });
});

describe('renderActContract', () => {
  it('includes the tabs tool alongside the other action tools', () => {
    const contract = renderActContract();
    expect(contract).toContain('tabs —');
    expect(contract).toContain('read_page —');
    expect(contract).toContain('navigate —');
  });
});

describe('buildPairedActPrompt', () => {
  it('embeds the system prompt, the JSON contract, and the history', () => {
    const prompt = buildPairedActPrompt('SYSTEM', ['> {"action":"read_page"}', '= read 5 elements']);
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('read 5 elements');
    // The contract tells the model exactly how to reply.
    expect(prompt).toContain('"done":true');
    expect(prompt).toContain('read_page');
  });

  it('nudges an empty history to start by reading the page', () => {
    expect(buildPairedActPrompt('S', [])).toContain('start by reading the page');
  });
});

describe('buildSessionStepMessage', () => {
  it('turn 0 nudges the same way the empty legacy history does', () => {
    const msg = buildSessionStepMessage(null);
    expect(msg).toContain('start by reading the page');
    expect(msg).toContain('Reply with the next single JSON object now:');
  });

  it('an invalid reply gets the same nudge line the legacy history keeps', () => {
    const msg = buildSessionStepMessage('invalid');
    expect(msg).toContain('was not a single JSON action');
    expect(msg).toContain('Reply with the next single JSON object now:');
  });

  it('a normal turn carries the action and its result, capped, in history line format', () => {
    const action = '{"action":"read_page","args":{}}';
    const msg = buildSessionStepMessage({ action, result: 'read 5 elements' });
    // Same `> action` / `= result` shape buildPairedActPrompt's history uses,
    // so a mid-run bootstrap respawn reads as the same conversation.
    expect(msg).toContain(`> ${action}`);
    expect(msg).toContain('= read 5 elements');
    expect(msg).toContain('Reply with the next single JSON object now:');
  });

  it('caps a huge result at the same 6000 chars the history keeps', () => {
    const msg = buildSessionStepMessage({ action: '{"action":"read_page"}', result: 'x'.repeat(20_000) });
    expect(msg.length).toBeLessThan(6300);
  });
});

describe('BYOK system/goal split (buildActSystemPrompt / buildActUserGoal)', () => {
  const spec: WorkflowSpec = {
    v: 1,
    site: 'example.com',
    intent: 'search and open the first result',
    params: [{ name: 'query', description: 'what to search', example: 'shoes', required: true }],
    steps: [
      { id: 'step-1', intent: 'type {query} into the search box' },
      { id: 'step-2', intent: 'open the first result' },
    ],
    successCriteria: 'a result page is open',
    sourceTraceId: 'tr_1',
    recordedAt: new Date(0).toISOString(),
  };

  it('a free goal: system is exactly the steering, the goal rides in the user message', () => {
    expect(buildActSystemPrompt(null)).toBe(ACT_STEERING);
    const goal = buildActUserGoal('find the price');
    expect(goal).toContain('GOAL: find the price');
    expect(goal).not.toContain(ACT_STEERING.slice(0, 40));
  });

  it('a replay: everything STATIC (steering + workflow) is in system, only the request is per-run', () => {
    const system = buildActSystemPrompt(spec);
    expect(system).toContain(ACT_STEERING.slice(0, 40));
    expect(system).toContain('WORKFLOW: search and open the first result');
    expect(system).toContain('type {query} into the search box');
    expect(system).toContain('Done when: a result page is open');
    const goal = buildActUserGoal('search for boots', spec);
    expect(goal).toContain('USER REQUEST: search for boots');
    expect(goal).toContain('example.com');
    expect(goal).not.toContain('WORKFLOW:');
  });

  it('split content matches the fused paired builders — no drift between the two transports', () => {
    // Every line of the fused paired prompt must appear in exactly one half of
    // the split, so the BYOK agent reasons from the same instructions.
    const fused = buildWorkflowRunPrompt(spec, 'search for boots');
    const halves = buildActSystemPrompt(spec) + '\n' + buildActUserGoal('search for boots', spec);
    for (const line of fused.split('\n').filter((l) => l.trim())) {
      expect(halves).toContain(line);
    }
    const fusedFree = buildSteeringPrompt('find the price');
    const halvesFree = buildActSystemPrompt(null) + '\n' + buildActUserGoal('find the price');
    for (const line of fusedFree.split('\n').filter((l) => l.trim())) {
      expect(halvesFree).toContain(line);
    }
  });
});
