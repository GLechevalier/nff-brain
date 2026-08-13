import { describe, expect, it } from 'vitest';
import {
  applyWorkflow,
  buildWorkflowPrompt,
  compactTrace,
  emptyBrain,
  eventSignature,
  parseWorkflowResponse,
  validateWorkflowSpec,
  type TraceEvent,
  type TraceRecord,
} from '../src/index.js';

function ev(kind: TraceEvent['kind'], name: string, extra: Partial<TraceEvent> = {}): TraceEvent {
  return { t: 0, kind, url: 'https://www.linkedin.com/x', target: { tag: 'button', role: 'button', name }, ...extra };
}

describe('compactTrace', () => {
  it('detects a repeated connect loop and tags its events', () => {
    // open profile → connect → back, three times.
    const body = () => [ev('click', 'View profile'), ev('click', 'Connect'), ev('click', 'Back')];
    const events = [ev('input', 'Search'), ...body(), ...body(), ...body()];
    const { repeatGroups, dominant, events: tagged } = compactTrace(events);
    expect(repeatGroups).toBe(1);
    expect(dominant).toMatchObject({ period: 3, reps: 3 });
    // The three-per-iteration loop body events are tagged.
    expect(tagged.filter((e) => e.repeatGroup === 1).length).toBe(9);
    expect(tagged[0]!.repeatGroup).toBeUndefined(); // the initial search is not part of the loop
  });

  it('finds no loop in a linear trace', () => {
    const events = [ev('input', 'a'), ev('click', 'b'), ev('submit', 'c')];
    expect(compactTrace(events).repeatGroups).toBe(0);
  });

  it('ignores the typed value when matching, so different names still loop', () => {
    expect(eventSignature(ev('input', 'Name', { value: 'Alice' }))).toBe(
      eventSignature(ev('input', 'Name', { value: 'Bob' })),
    );
  });
});

describe('buildWorkflowPrompt', () => {
  it('renders index-addressed events with repeat-group annotations and the verb list', () => {
    const trace: TraceRecord = {
      v: 1,
      id: 'trc_1',
      startedAt: 'x',
      endedAt: 'y',
      startUrl: 'https://www.linkedin.com/search',
      events: [ev('input', 'Search', { value: 'robotics' }), ev('click', 'Connect'), ev('click', 'Connect')],
      source: 'chrome',
    };
    const { prompt } = buildWorkflowPrompt(trace);
    expect(prompt).toContain('You are the workflow distiller');
    expect(prompt).toContain('#0 [input]');
    expect(prompt).toContain('pointer.click'); // the allowed-verb list is embedded
    expect(prompt).toContain('www.linkedin.com');
  });
});

describe('parseWorkflowResponse / validateWorkflowSpec', () => {
  const ctx = { sourceTraceId: 'trc_1', recordedAt: '2026-08-13T00:00:00Z', site: 'www.linkedin.com' };

  it('parses a well-formed workflow and mints step ids', () => {
    const raw = JSON.stringify({
      intent: 'connect with people matching a query',
      params: [{ name: 'query', description: 'search text', example: 'robotics', required: true }],
      steps: [
        { intent: 'search for {query}', verbs: ['key.type', 'key.press'], params: ['query'] },
        {
          intent: 'connect with each result',
          loop: { over: 'results', countParam: 'count', body: [{ intent: 'open profile', verbs: ['pointer.click'] }] },
        },
      ],
      successCriteria: 'count connections sent',
    });
    const wf = parseWorkflowResponse(raw, ctx)!;
    expect(wf.steps[0]!.id).toBe('step-1');
    expect(wf.steps[1]!.loop!.body[0]!.id).toBe('step-2-1');
    expect(wf.params[0]!.name).toBe('query');
    expect(wf.sourceTraceId).toBe('trc_1'); // trusted provenance, not from the model
  });

  it('drops invalid verbs but keeps the step', () => {
    const wf = validateWorkflowSpec(
      { steps: [{ intent: 'do a thing', verbs: ['pointer.click', 'evil.eval'] }] },
      ctx,
    )!;
    expect(wf.steps[0]!.hint?.verbs).toEqual(['pointer.click']);
  });

  it('returns null when there are no usable steps', () => {
    expect(parseWorkflowResponse('not json', ctx)).toBeNull();
    expect(validateWorkflowSpec({ steps: [] }, ctx)).toBeNull();
  });

  it('does not nest loops beyond one level', () => {
    const wf = validateWorkflowSpec(
      { steps: [{ intent: 'outer', loop: { over: 'a', body: [{ intent: 'inner', loop: { over: 'b', body: [{ intent: 'deep' }] } }] } }] },
      ctx,
    )!;
    expect(wf.steps[0]!.loop!.body[0]!.loop).toBeUndefined();
  });
});

describe('applyWorkflow', () => {
  const ctx = { sourceTraceId: 'trc_1', recordedAt: '2026-08-13T00:00:00Z', site: 'www.linkedin.com' };
  const spec = validateWorkflowSpec(
    { intent: 'connect with CTOs', steps: [{ intent: 'search {query}' }], params: [{ name: 'query', example: 'cto', description: 'q', required: true }] },
    ctx,
  )!;

  it('creates one workflow-origin node carrying the payload', () => {
    const brain = emptyBrain();
    const { id } = applyWorkflow(brain, spec, 'Connect with CTOs', new Date('2026-08-13T00:00:00Z'));
    const node = brain.nodes.find((n) => n.id === id)!;
    expect(node.origin).toBe('workflow');
    expect(node.category).toBe('strategy');
    expect(node.workflow).toEqual(spec);
    expect(node.content).toContain('search {query}');
  });

  it('caps workflow nodes, evicting the least-recalled', () => {
    const brain = emptyBrain();
    for (let i = 0; i < 55; i++) {
      applyWorkflow(brain, spec, `Flow ${i}`, new Date(`2026-08-13T00:00:${String(i).padStart(2, '0')}Z`));
    }
    expect(brain.nodes.filter((n) => n.origin === 'workflow').length).toBe(50);
  });
});
