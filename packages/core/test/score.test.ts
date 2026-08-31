import { describe, expect, it } from 'vitest';
import { rankNodes, scoreNode, trigramSim } from '../src/score.js';

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

// ── FROZEN SCALE TRIPWIRE ────────────────────────────────────────────────────
// These exact numbers are not arbitrary trivia — they are the scale that other
// modules are calibrated against, and nothing else pins them:
//   • novelty.ts computes coverage = clamp01(topScore / 0.35) and cuts the
//     model ladder at DEFAULT_THRESHOLDS [0.35, 0.7]. Note below that a strong
//     match lands at 0.70–0.78, so 0.35 is genuinely mid-scale. Rescale
//     scoreNode and the ladder silently pins to one model.
//   • mergePass.ts gates merge candidates on trigramSim >= 0.36 and > 0.1.
// Semantic similarity must never be blended in here — it lives in rank.ts on
// its own scale. If you are changing these values, you are also changing
// novelty thresholds and the merge gate. Do both deliberately.
describe('frozen lexical scale', () => {
  const ps = NODES[0]!;
  const pg = NODES[1]!;
  const dns = NODES[2]!;

  it('pins scoreNode for a strong title match', () => {
    expect(scoreNode('powershell quoting', ps)).toBeCloseTo(0.7475728155, 9);
    expect(scoreNode('docker restart containers', dns)).toBeCloseTo(0.7735849057, 9);
    expect(scoreNode('migrations', pg)).toBeCloseTo(0.6987654321, 9);
  });

  it('pins scoreNode for non-matches (the noise floor)', () => {
    expect(scoreNode('powershell quoting', pg)).toBeCloseTo(0.0179775281, 9);
    expect(scoreNode('docker restart containers', ps)).toBeCloseTo(0.0145454545, 9);
    expect(scoreNode('migrations', ps)).toBe(0);
  });

  it('pins trigramSim, which is the merge gate', () => {
    expect(trigramSim('Fleet DNS wedge', 'Fleet DNS wedge')).toBe(1);
    expect(trigramSim('Fleet DNS wedge', 'Fleet DNS wedge fix')).toBeCloseTo(0.8888888889, 9);
    expect(trigramSim(ps.title, pg.title)).toBeCloseTo(0.1333333333, 9);
  });

  it('keeps a strong match well above the 0.35 novelty cut and below 1.0', () => {
    for (const [q, n] of [
      ['powershell quoting', ps],
      ['docker restart containers', dns],
      ['migrations', pg],
    ] as const) {
      const s = scoreNode(q, n);
      expect(s).toBeGreaterThan(0.35);
      expect(s).toBeLessThan(1);
    }
  });
});
