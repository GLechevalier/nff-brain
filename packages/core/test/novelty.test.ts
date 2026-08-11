import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOWNGRADE_STREAK,
  DEFAULT_HYSTERESIS,
  DEFAULT_LADDER,
  DEFAULT_THRESHOLDS,
  MIN_SIGNAL_TOKENS,
  applyHysteresis,
  modelLadder,
  pickModel,
  policyOptions,
  scoreNovelty,
} from '../src/index.js';
import type { BrainEdge, BrainNode } from '../src/index.js';

function node(id: string, title: string, content: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title,
    category: 'strategy',
    content,
    color: '#a78bfa',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    recallCount: 0,
    ...extra,
  };
}

describe('modelLadder', () => {
  it('defaults without env', () => {
    const { ladder, thresholds } = modelLadder({});
    expect(ladder).toEqual([...DEFAULT_LADDER]);
    expect(thresholds).toEqual([...DEFAULT_THRESHOLDS]);
  });

  it('reads a custom ladder and thresholds', () => {
    const { ladder, thresholds } = modelLadder({
      NFF_BRAIN_MODEL_LADDER: 'sonnet, opus',
      NFF_BRAIN_NOVELTY_THRESHOLDS: '0.5',
    });
    expect(ladder).toEqual(['sonnet', 'opus']);
    expect(thresholds).toEqual([0.5]);
  });

  it('falls back to even spacing when thresholds are malformed for the ladder', () => {
    // Wrong length for a 2-tier ladder.
    const a = modelLadder({ NFF_BRAIN_MODEL_LADDER: 'sonnet,opus', NFF_BRAIN_NOVELTY_THRESHOLDS: '0.3,0.6' });
    expect(a.thresholds).toEqual([0.5]);
    // Non-ascending.
    const b = modelLadder({ NFF_BRAIN_NOVELTY_THRESHOLDS: '0.7,0.3' });
    expect(b.thresholds).toEqual([...DEFAULT_THRESHOLDS]);
    // Non-numeric.
    const c = modelLadder({ NFF_BRAIN_NOVELTY_THRESHOLDS: 'low,high' });
    expect(c.thresholds).toEqual([...DEFAULT_THRESHOLDS]);
    // 4-tier ladder without thresholds → even spacing.
    const d = modelLadder({ NFF_BRAIN_MODEL_LADDER: 'haiku,sonnet,opus,fable' });
    expect(d.thresholds).toEqual([0.25, 0.5, 0.75]);
  });

  it('ignores an empty ladder value', () => {
    const { ladder } = modelLadder({ NFF_BRAIN_MODEL_LADDER: ' , ,' });
    expect(ladder).toEqual([...DEFAULT_LADDER]);
  });
});

describe('pickModel', () => {
  it('maps novelty to tiers with exclusive upper cuts', () => {
    const ladder = ['haiku', 'sonnet', 'opus'];
    const thresholds = [0.35, 0.7];
    expect(pickModel(0, ladder, thresholds)).toBe('haiku');
    expect(pickModel(0.34, ladder, thresholds)).toBe('haiku');
    expect(pickModel(0.35, ladder, thresholds)).toBe('sonnet');
    expect(pickModel(0.69, ladder, thresholds)).toBe('sonnet');
    expect(pickModel(0.7, ladder, thresholds)).toBe('opus');
    expect(pickModel(1, ladder, thresholds)).toBe('opus');
  });
});

describe('scoreNovelty', () => {
  const edgesFor = (hub: string, n: number, strength: number): BrainEdge[] =>
    Array.from({ length: n }, (_, i) => ({ from: hub, to: `nb-${i}`, strength }));

  it('empty graph is maximally novel → frontier model', () => {
    const r = scoreNovelty({ nodes: [], edges: [] }, 'anything at all');
    expect(r.novelty).toBe(1);
    expect(r.model).toBe(r.ladder[r.ladder.length - 1]);
    expect(r.top).toHaveLength(0);
  });

  it('empty/stopword-only query is maximally novel', () => {
    const nodes = [node('a', 'Alpha', 'aaa')];
    expect(scoreNovelty({ nodes, edges: [] }, '').novelty).toBe(1);
    expect(scoreNovelty({ nodes, edges: [] }, 'the and for').novelty).toBe(1);
  });

  it('no lexical match is maximally novel even on a tiny graph (no whole-graph bypass)', () => {
    const nodes = [node('a', 'Docker restart', 'force-recreate wedged containers')];
    const r = scoreNovelty({ nodes, edges: [] }, 'zzzzqqqq quantum entanglement telescope');
    expect(r.novelty).toBe(1);
    expect(r.top).toHaveLength(0);
  });

  it('a strong, well-connected, often-recalled anchor makes the task familiar → cheap model', () => {
    const strong = node('docker-restart', 'Docker restart procedure', 'force-recreate wedged containers with compose', {
      recallCount: 40,
    });
    const neighbors = Array.from({ length: 7 }, (_, i) => node(`nb-${i}`, `Neighbor ${i}`, `filler ${i}`));
    const r = scoreNovelty(
      { nodes: [strong, ...neighbors], edges: edgesFor('docker-restart', 7, 0.9) },
      'docker restart procedure for wedged containers',
    );
    expect(r.top[0].id).toBe('docker-restart');
    expect(r.novelty).toBeLessThan(0.35);
    expect(r.model).toBe('sonnet');
  });

  it('a matching but weak periphery node stays novel → frontier model', () => {
    const weak = node('weak', 'Quantum telemetry probe', 'experimental quantum telemetry probe notes', {
      recallCount: 0,
    });
    const other = node('other', 'Other', 'unrelated filler');
    const edges: BrainEdge[] = [{ from: 'weak', to: 'other', strength: 0.3 }];
    const r = scoreNovelty({ nodes: [weak, other], edges }, 'quantum telemetry probe experiments');
    expect(r.top[0].id).toBe('weak');
    expect(r.novelty).toBeGreaterThanOrEqual(0.7);
    expect(r.model).toBe('fable');
  });

  it('a middling anchor lands on the middle tier', () => {
    const mid = node('mid', 'Fleet enrollment flow', 'devices announce then get claimed and enrolled', {
      recallCount: 2,
    });
    const nbs = [node('nb-0', 'NB0', 'x'), node('nb-1', 'NB1', 'y')];
    const edges: BrainEdge[] = [
      { from: 'mid', to: 'nb-0', strength: 0.5 },
      { from: 'mid', to: 'nb-1', strength: 0.5 },
    ];
    const r = scoreNovelty({ nodes: [mid, ...nbs], edges }, 'fleet enrollment flow for devices');
    expect(r.top[0].id).toBe('mid');
    expect(r.novelty).toBeGreaterThanOrEqual(0.35);
    expect(r.novelty).toBeLessThan(0.7);
    expect(r.model).toBe('opus');
  });

  it('weak lexical coverage keeps novelty high even when the matched node is strong', () => {
    const strong = node('strong', 'Docker restart procedure', 'force-recreate wedged containers', {
      recallCount: 40,
    });
    const neighbors = Array.from({ length: 7 }, (_, i) => node(`nb-${i}`, `Neighbor ${i}`, `filler ${i}`));
    const graph = { nodes: [strong, ...neighbors], edges: edgesFor('strong', 7, 0.9) };
    // Only one of many query tokens grazes the node — coverage should damp familiarity.
    const grazing = scoreNovelty(graph, 'kubernetes ingress certificate rotation on the docker host maybe');
    const direct = scoreNovelty(graph, 'docker restart procedure for wedged containers');
    expect(grazing.novelty).toBeGreaterThan(direct.novelty);
  });

  it('respects an explicit ladder/thresholds override', () => {
    const r = scoreNovelty({ nodes: [], edges: [] }, 'anything', {
      ladder: ['a', 'b'],
      thresholds: [0.5],
    });
    expect(r.model).toBe('b');
    expect(r.ladder).toEqual(['a', 'b']);
  });
});

describe('scoreNovelty signal gate', () => {
  const graph = {
    nodes: [node('docker-restart', 'Docker restart procedure', 'force-recreate wedged containers')],
    edges: [] as BrainEdge[],
  };

  it('flags continuation prompts as having no signal', () => {
    // These are the ones that used to demand the frontier model: they score
    // novelty 1 not because the brain is ignorant but because there is nothing
    // in them to match.
    for (const prompt of ['', 'ok', 'yes', 'continue', 'go ahead', 'the and for']) {
      const r = scoreNovelty(graph, prompt);
      expect(r.hasSignal, prompt).toBe(false);
      expect(r.signalTokens, prompt).toBeLessThan(MIN_SIGNAL_TOKENS);
    }
  });

  it('a real two-token task has signal', () => {
    const r = scoreNovelty(graph, 'restart docker');
    expect(r.hasSignal).toBe(true);
    expect(r.signalTokens).toBe(2);
  });

  it('counts only meaningful tokens (stopwords and short words dropped)', () => {
    // "do"/"it" are under 3 chars, "the"/"for" are stopwords → docker, wedged.
    expect(scoreNovelty(graph, 'do it for the docker wedged').signalTokens).toBe(2);
  });

  it('a long unfamiliar prompt still has signal and still escalates', () => {
    // The gate must not swallow real novelty: this one IS new territory, and
    // the frontier model is the right answer.
    const r = scoreNovelty(graph, 'design a quantum telemetry cascade subsystem from scratch');
    expect(r.hasSignal).toBe(true);
    expect(r.novelty).toBeGreaterThanOrEqual(0.7);
    expect(r.model).toBe('fable');
  });

  it('respects a minSignalTokens override', () => {
    expect(scoreNovelty(graph, 'restart docker', { minSignalTokens: 3 }).hasSignal).toBe(false);
    expect(scoreNovelty(graph, 'ok', { minSignalTokens: 0 }).hasSignal).toBe(true);
  });
});

describe('policyOptions', () => {
  it('defaults without env', () => {
    expect(policyOptions({})).toEqual({
      margin: DEFAULT_HYSTERESIS,
      downgradeStreak: DEFAULT_DOWNGRADE_STREAK,
      minSignalTokens: MIN_SIGNAL_TOKENS,
    });
  });

  it('reads overrides', () => {
    expect(
      policyOptions({
        NFF_BRAIN_NOVELTY_HYSTERESIS: '0.1',
        NFF_BRAIN_DOWNGRADE_STREAK: '3',
        NFF_BRAIN_MIN_SIGNAL_TOKENS: '4',
      }),
    ).toEqual({ margin: 0.1, downgradeStreak: 3, minSignalTokens: 4 });
  });

  it('falls back silently on malformed values — a typo must never break a hook', () => {
    const bad = policyOptions({
      NFF_BRAIN_NOVELTY_HYSTERESIS: 'wide', // non-numeric
      NFF_BRAIN_DOWNGRADE_STREAK: '0', // must be >= 1
      NFF_BRAIN_MIN_SIGNAL_TOKENS: '-1', // must be >= 0
    });
    expect(bad).toEqual({
      margin: DEFAULT_HYSTERESIS,
      downgradeStreak: DEFAULT_DOWNGRADE_STREAK,
      minSignalTokens: MIN_SIGNAL_TOKENS,
    });
    // A margin big enough to invert the cuts is refused too.
    expect(policyOptions({ NFF_BRAIN_NOVELTY_HYSTERESIS: '0.9' }).margin).toBe(DEFAULT_HYSTERESIS);
    // Fractional streaks are not a thing.
    expect(policyOptions({ NFF_BRAIN_DOWNGRADE_STREAK: '2.5' }).downgradeStreak).toBe(DEFAULT_DOWNGRADE_STREAK);
  });
});

describe('applyHysteresis', () => {
  const ladder = [...DEFAULT_LADDER];
  const thresholds = [...DEFAULT_THRESHOLDS];
  const apply = (prev: { model: string; belowStreak: number } | null, novelty: number) =>
    applyHysteresis(prev, novelty, ladder, thresholds);

  it('adopts the raw pick with no history', () => {
    expect(apply(null, 0.9)).toEqual({ model: 'fable', belowStreak: 0 });
    expect(apply(null, 0.1)).toEqual({ model: 'sonnet', belowStreak: 0 });
  });

  it('adopts the raw pick when the remembered tier is not on the ladder', () => {
    // Someone edited NFF_BRAIN_MODEL_LADDER mid-session.
    expect(apply({ model: 'haiku', belowStreak: 1 }, 0.9)).toEqual({ model: 'fable', belowStreak: 0 });
  });

  it('holds inside the upgrade band and moves outside it', () => {
    const prev = { model: 'sonnet', belowStreak: 0 };
    // Past the raw cut (0.35) but still inside the band — no move. The exact
    // edge is left untested: 0.35 + 0.05 is 0.39999999999999997 in binary
    // floating point, so which side 0.4 lands on is an artefact, not behaviour.
    expect(apply(prev, 0.36).model).toBe('sonnet');
    expect(apply(prev, 0.39).model).toBe('sonnet');
    expect(apply(prev, 0.42).model).toBe('opus'); // clear of the band
  });

  it('upgrades straight to the tier novelty asks for, skipping rungs', () => {
    expect(apply({ model: 'sonnet', belowStreak: 0 }, 0.95)).toEqual({ model: 'fable', belowStreak: 0 });
  });

  it('holds inside the downgrade band without arming the streak', () => {
    const prev = { model: 'fable', belowStreak: 0 };
    expect(apply(prev, 0.66)).toEqual({ model: 'fable', belowStreak: 0 }); // 0.66 >= 0.70 - 0.05
  });

  it('needs two consecutive below-band prompts to give up a tier', () => {
    const first = apply({ model: 'fable', belowStreak: 0 }, 0.2);
    expect(first).toEqual({ model: 'fable', belowStreak: 1 }); // armed, not fired
    const second = apply(first, 0.2);
    expect(second).toEqual({ model: 'sonnet', belowStreak: 0 });
  });

  it('a single in-band prompt resets the streak', () => {
    const armed = apply({ model: 'fable', belowStreak: 0 }, 0.2);
    expect(armed.belowStreak).toBe(1);
    const reset = apply(armed, 0.8); // back up in fable territory
    expect(reset).toEqual({ model: 'fable', belowStreak: 0 });
    // …so the next low prompt starts counting from scratch.
    expect(apply(reset, 0.2)).toEqual({ model: 'fable', belowStreak: 1 });
  });

  it('honours a custom streak length', () => {
    let s = { model: 'fable', belowStreak: 0 };
    for (let i = 0; i < 2; i++) {
      s = applyHysteresis(s, 0.1, ladder, thresholds, { downgradeStreak: 3 });
      expect(s.model).toBe('fable');
    }
    expect(applyHysteresis(s, 0.1, ladder, thresholds, { downgradeStreak: 3 }).model).toBe('sonnet');
  });

  it('reproduces the agreed five-prompt trace', () => {
    const seen: string[] = [];
    let s: { model: string; belowStreak: number } | null = null;
    for (const novelty of [0.8, 0.2, 0.18, 0.38, 0.42]) {
      s = apply(s, novelty);
      seen.push(s.model);
    }
    expect(seen).toEqual(['fable', 'fable', 'sonnet', 'sonnet', 'opus']);
  });
});
