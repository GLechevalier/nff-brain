import { describe, expect, it } from 'vitest';
import { buildFilterPrompt, parseFilterResponse } from '../src/index.js';
import type { AgentCard } from '../src/index.js';

const cards: AgentCard[] = [
  { name: 'Ada Lovelace', headline: 'Robotics Engineer at Acme Robotics' },
  { name: 'Bob Smith', headline: 'Sales Manager at BigCorp' },
];

describe('buildFilterPrompt', () => {
  it('opens with the registered marker, states the criteria, and lists cards by index only', () => {
    const p = buildFilterPrompt('robotics engineer at a Series A startup', cards);
    expect(p.startsWith("You are the web agent's judgment call")).toBe(true);
    expect(p).toContain('robotics engineer at a Series A startup');
    expect(p).toContain('#0 Ada Lovelace');
    expect(p).toContain('#1 Bob Smith');
  });
});

describe('parseFilterResponse', () => {
  it('translates matched indices, dropping out-of-range and duplicate ones', () => {
    const matches = parseFilterResponse(
      JSON.stringify({ matches: [{ i: 0, reason: 'robotics' }, { i: 99, reason: 'bad' }, { i: 0, reason: 'dup' }] }),
      cards,
    );
    expect(matches).toEqual([{ index: 0, reason: 'robotics' }]);
  });

  it('an empty matches array is a legitimate "no matches", not an error', () => {
    expect(parseFilterResponse(JSON.stringify({ matches: [] }), cards)).toEqual([]);
  });

  it('returns [] rather than throwing on unparseable input', () => {
    expect(parseFilterResponse('total garbage', cards)).toEqual([]);
    expect(parseFilterResponse('', cards)).toEqual([]);
  });

  it('never trusts a model-supplied name — only the index addresses a card', () => {
    const matches = parseFilterResponse(JSON.stringify({ matches: [{ i: 1, reason: 'x' }] }), cards);
    expect(matches).toEqual([{ index: 1, reason: 'x' }]);
    expect(cards[matches[0].index].name).toBe('Bob Smith');
  });
});
