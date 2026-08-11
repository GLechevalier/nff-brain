import { describe, expect, it } from 'vitest';
import { rankNodes } from '../src/score.js';

function node(title: string, content: string) {
  return { title, content };
}

const NODES = [
  node('PowerShell quoting rules', 'Use here-strings for multiline args; backtick escapes break.'),
  node('Postgres migrations', 'Never edit applied migrations; add a new forward db migration file.'),
  node('Fleet DNS wedge', 'Containers going offline need force-recreate, not docker restart.'),
];

describe('rankNodes', () => {
  it('ranks an exact title match first', () => {
    const ranked = rankNodes('powershell quoting', NODES);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.node.title).toBe('PowerShell quoting rules');
  });

  it('matches short substring queries below the tokenize cutoff', () => {
    const ranked = rankNodes('db', NODES);
    expect(ranked.map((r) => r.node.title)).toContain('Postgres migrations');
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(0.5);
  });

  it('returns [] for an empty or whitespace query', () => {
    expect(rankNodes('', NODES)).toEqual([]);
    expect(rankNodes('   ', NODES)).toEqual([]);
  });

  it('respects the limit option', () => {
    const ranked = rankNodes('migrations restart quoting', NODES, { limit: 1, minScore: 0 });
    expect(ranked).toHaveLength(1);
  });

  it('excludes non-matching nodes', () => {
    const titles = rankNodes('kubernetes ingress', NODES).map((r) => r.node.title);
    expect(titles).not.toContain('PowerShell quoting rules');
  });
});
