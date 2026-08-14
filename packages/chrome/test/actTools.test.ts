import { describe, expect, it } from 'vitest';
import { buildPairedActPrompt, parseActAction, renderActContract } from '../src/actTools.js';

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
