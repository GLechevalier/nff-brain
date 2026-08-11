import { describe, expect, it } from 'vitest';
import { DEFAULT_SEMANTIC_FLOOR, fuseRanked } from '../src/rank.js';
import { rankNodes } from '../src/score.js';

function node(id: string, title: string, content: string) {
  return { id, title, content };
}

const NODES = [
  node('powershell-quoting', 'PowerShell quoting rules', 'Use here-strings for multiline args; backtick escapes break.'),
  node('pg-migrations', 'Postgres migrations', 'Never edit applied migrations; add a new forward db migration file.'),
  node('fleet-dns', 'Fleet DNS wedge', 'Containers going offline need force-recreate, not docker restart.'),
  node('ghcr-pat', 'GHCR PAT fallback', 'A denied push usually means a bad VPS login or a cross-repo race.'),
];

describe('fuseRanked — the pure-lexical invariant', () => {
  // This is the contract that lets every call site adopt fuseRanked before
  // embeddings exist. If it breaks, Phase 0 was not a no-op.
  for (const q of ['powershell quoting', 'db', 'migrations restart quoting', 'containers offline']) {
    it(`is identical to rankNodes for "${q}"`, () => {
      const lex = rankNodes(q, NODES);
      const fused = fuseRanked(q, NODES, null);
      expect(fused.map((h) => h.node.id)).toEqual(lex.map((r) => r.node.id));
      expect(fused.map((h) => h.lexical)).toEqual(lex.map((r) => r.score));
      expect(fused.map((h) => h.fused)).toEqual(lex.map((r) => r.score));
      expect(fused.every((h) => h.semantic === 0)).toBe(true);
    });
  }

  it('is identical to rankNodes under a limit', () => {
    const opts = { limit: 2, minScore: 0 };
    expect(fuseRanked('migrations restart quoting', NODES, null, opts).map((h) => h.node.id)).toEqual(
      rankNodes('migrations restart quoting', NODES, opts).map((r) => r.node.id),
    );
  });

  it('treats an empty semantic list as no semantic list', () => {
    expect(fuseRanked('db', NODES, [])).toEqual(fuseRanked('db', NODES, null));
  });

  it('returns [] for an empty or whitespace query', () => {
    expect(fuseRanked('', NODES, [{ id: 'fleet-dns', sim: 0.99 }])).toEqual([]);
    expect(fuseRanked('   ', NODES, null)).toEqual([]);
  });
});

describe('fuseRanked — fusion', () => {
  it('surfaces a semantic-only hit that lexical scoring cannot see', () => {
    // No shared tokens, no shared trigrams: pure lexical finds nothing useful.
    const q = 'my boxes keep dropping off the network';
    expect(rankNodes(q, NODES).map((r) => r.node.id)).not.toContain('fleet-dns');

    const hits = fuseRanked(q, NODES, [{ id: 'fleet-dns', sim: 0.88 }]);
    const dns = hits.find((h) => h.node.id === 'fleet-dns');
    expect(dns).toBeDefined();
    expect(dns!.lexical).toBe(0);
    expect(dns!.semantic).toBeCloseTo(0.88, 6);
  });

  it('ranks a node that both signals agree on above a single-signal node', () => {
    const hits = fuseRanked('docker containers restart', NODES, [
      { id: 'fleet-dns', sim: 0.91 },
      { id: 'ghcr-pat', sim: 0.86 },
    ]);
    expect(hits[0]!.node.id).toBe('fleet-dns'); // top of both lists
    expect(hits.findIndex((h) => h.node.id === 'fleet-dns')).toBeLessThan(
      hits.findIndex((h) => h.node.id === 'ghcr-pat'),
    );
  });

  it('drops semantic candidates below the absolute floor', () => {
    // ~0.40 is the measured unrelated-query baseline for bge-small — never a
    // match. See DEFAULT_SEMANTIC_FLOOR for the sampled distribution.
    const hits = fuseRanked('powershell quoting', NODES, [{ id: 'fleet-dns', sim: 0.42 }]);
    expect(hits.map((h) => h.node.id)).not.toContain('fleet-dns');
  });

  it('admits a candidate at the measured true-positive level', () => {
    const hits = fuseRanked('boxes dropping off the network', NODES, [{ id: 'fleet-dns', sim: 0.59 }]);
    expect(hits.map((h) => h.node.id)).toContain('fleet-dns');
  });

  it('drops semantic candidates far below the best cosine, even above the floor', () => {
    const hits = fuseRanked('powershell quoting', NODES, [
      { id: 'pg-migrations', sim: 0.88 },
      { id: 'fleet-dns', sim: 0.6 }, // above the 0.55 floor, but 0.28 behind the leader
    ]);
    const ids = hits.map((h) => h.node.id);
    expect(ids).toContain('pg-migrations');
    expect(hits.find((h) => h.node.id === 'fleet-dns')?.semantic ?? 0).toBe(0);
  });

  it('uses the floor constant, so re-tuning it cannot silently drift', () => {
    const justUnder = DEFAULT_SEMANTIC_FLOOR - 0.01;
    const justOver = DEFAULT_SEMANTIC_FLOOR + 0.01;
    expect(fuseRanked('quoting', NODES, [{ id: 'fleet-dns', sim: justUnder }]).map((h) => h.node.id)).not.toContain(
      'fleet-dns',
    );
    expect(fuseRanked('quoting', NODES, [{ id: 'fleet-dns', sim: justOver }]).map((h) => h.node.id)).toContain(
      'fleet-dns',
    );
  });

  it('ignores semantic hits for ids that are not in the node list', () => {
    const hits = fuseRanked('db', NODES, [{ id: 'does-not-exist', sim: 0.99 }]);
    expect(hits.map((h) => h.node.id)).not.toContain('does-not-exist');
  });

  it('sorts an unsorted semantic list rather than trusting the caller', () => {
    const asc = fuseRanked('docker restart', NODES, [
      { id: 'ghcr-pat', sim: 0.83 },
      { id: 'fleet-dns', sim: 0.93 },
    ]);
    const desc = fuseRanked('docker restart', NODES, [
      { id: 'fleet-dns', sim: 0.93 },
      { id: 'ghcr-pat', sim: 0.83 },
    ]);
    expect(asc.map((h) => h.node.id)).toEqual(desc.map((h) => h.node.id));
  });

  it('respects the limit after fusion', () => {
    const hits = fuseRanked('docker restart migrations', NODES, [{ id: 'fleet-dns', sim: 0.9 }], {
      limit: 1,
      minScore: 0,
    });
    expect(hits).toHaveLength(1);
  });
});
