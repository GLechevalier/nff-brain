import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_QUANTILES,
  MAX_SAMPLES,
  MIN_SAMPLES_TO_CALIBRATE,
  appendSample,
  calibratedThresholds,
  calibrationQuantiles,
  quantile,
  quantileThresholds,
  readSamples,
  samplesPath,
} from '../src/index.js';

/** n samples spread evenly over [lo, hi] — a stand-in for a real distribution. */
const spread = (n: number, lo = 0, hi = 1): number[] =>
  Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

describe('quantile', () => {
  it('interpolates linearly between neighbours', () => {
    const s = [0, 0.25, 0.5, 0.75, 1];
    expect(quantile(s, 0)).toBe(0);
    expect(quantile(s, 1)).toBe(1);
    expect(quantile(s, 0.5)).toBe(0.5);
    expect(quantile(s, 0.125)).toBeCloseTo(0.125, 6);
  });

  it('degenerate inputs do not throw', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([0.4], 0.9)).toBe(0.4);
    expect(quantile([0, 1], -5)).toBe(0); // clamped
    expect(quantile([0, 1], 5)).toBe(1);
  });
});

describe('quantileThresholds', () => {
  it('places cuts at the requested quantiles of the observed spread', () => {
    const cuts = quantileThresholds(spread(100, 0.1, 0.9), 3, [0.5, 0.85]);
    expect(cuts).not.toBeNull();
    expect(cuts![0]).toBeCloseTo(0.5, 2); // median of 0.1..0.9
    expect(cuts![1]).toBeCloseTo(0.78, 2);
  });

  it('THE POINT: a clustered distribution still spreads across every tier', () => {
    // The real-world failure: every score lands in 0.36–0.48, so static cuts of
    // 0.35/0.7 send literally everything to the middle tier.
    const clustered = spread(100, 0.36, 0.48);
    const staticTiers = clustered.map((n) => (n < 0.35 ? 0 : n < 0.7 ? 1 : 2));
    expect(new Set(staticTiers)).toEqual(new Set([1])); // one tier, always

    const cuts = quantileThresholds(clustered, 3, [0.5, 0.85])!;
    const calTiers = clustered.map((n) => (n < cuts[0] ? 0 : n < cuts[1] ? 1 : 2));
    expect(new Set(calTiers)).toEqual(new Set([0, 1, 2])); // all three, in use
    // …and in the intended proportions.
    expect(calTiers.filter((t) => t === 0).length).toBeCloseTo(50, -1);
    expect(calTiers.filter((t) => t === 2).length).toBeCloseTo(15, -1);
  });

  it('refuses too few samples', () => {
    expect(quantileThresholds(spread(MIN_SAMPLES_TO_CALIBRATE - 1), 3)).toBeNull();
    expect(quantileThresholds(spread(MIN_SAMPLES_TO_CALIBRATE), 3)).not.toBeNull();
  });

  it('refuses a degenerate distribution rather than collapsing tiers', () => {
    // Every prompt scoring identically cannot produce ascending cuts — a
    // collapsed cut would silently make a tier unreachable.
    expect(quantileThresholds(new Array(60).fill(0.5), 3)).toBeNull();
    // All-maximal novelty (a brand-new brain) would put a cut at 1.0.
    expect(quantileThresholds(new Array(60).fill(1), 3)).toBeNull();
  });

  it('refuses a quantile count that does not match the ladder', () => {
    expect(quantileThresholds(spread(60), 3, [0.5])).toBeNull();
    expect(quantileThresholds(spread(60), 1, [])).toBeNull();
  });
});

describe('calibrationQuantiles', () => {
  it('defaults for a 3-tier ladder', () => {
    expect(calibrationQuantiles(3, {})).toEqual([...DEFAULT_QUANTILES]);
  });

  it('spaces evenly for other ladder sizes', () => {
    expect(calibrationQuantiles(4, {})).toEqual([0.25, 0.5, 0.75]);
  });

  it('reads an override and falls back silently on nonsense', () => {
    expect(calibrationQuantiles(3, { NFF_BRAIN_NOVELTY_QUANTILES: '0.6,0.9' })).toEqual([0.6, 0.9]);
    for (const bad of ['0.9,0.6', 'a,b', '0.5', '0,0.9', '0.5,1']) {
      expect(calibrationQuantiles(3, { NFF_BRAIN_NOVELTY_QUANTILES: bad }), bad).toEqual([...DEFAULT_QUANTILES]);
    }
  });
});

describe('sample store + calibratedThresholds', () => {
  let dir: string;
  let brainPath: string;
  const STATIC = [0.35, 0.7];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-cal-'));
    brainPath = path.join(dir, '.nff-brain', 'brain.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips samples and keeps only the newest MAX_SAMPLES', () => {
    for (const n of spread(10, 0.1, 0.9)) appendSample(brainPath, n);
    expect(readSamples(brainPath)).toHaveLength(10);
    for (let i = 0; i < MAX_SAMPLES + 20; i++) appendSample(brainPath, 0.5);
    expect(readSamples(brainPath)).toHaveLength(MAX_SAMPLES);
  });

  it('ignores junk on disk and out-of-range values', () => {
    fs.mkdirSync(path.dirname(brainPath), { recursive: true });
    fs.writeFileSync(samplesPath(brainPath), 'not json');
    expect(readSamples(brainPath)).toEqual([]);
    fs.writeFileSync(samplesPath(brainPath), JSON.stringify({ version: 1, samples: [0.5, 'x', 9, -1, null, 0.8] }));
    expect(readSamples(brainPath)).toEqual([0.5, 0.8]);
  });

  it('appendSample never throws on a bad value', () => {
    expect(() => appendSample(brainPath, Number.NaN)).not.toThrow();
    expect(readSamples(brainPath)).toEqual([]);
  });

  it('falls back to static cuts until enough samples exist, then calibrates', () => {
    const cold = calibratedThresholds(brainPath, 3, STATIC, {});
    expect(cold).toEqual({ thresholds: STATIC, calibrated: false, sampleCount: 0 });

    for (const n of spread(MIN_SAMPLES_TO_CALIBRATE + 20, 0.36, 0.48)) appendSample(brainPath, n);
    const warm = calibratedThresholds(brainPath, 3, STATIC, {});
    expect(warm.calibrated).toBe(true);
    expect(warm.sampleCount).toBe(MIN_SAMPLES_TO_CALIBRATE + 20);
    expect(warm.thresholds[0]).toBeGreaterThan(0.36);
    expect(warm.thresholds[1]).toBeLessThan(0.48); // cuts moved INTO the cluster
  });

  it('an explicit threshold override wins — the user outranks the calibrator', () => {
    for (const n of spread(60, 0.36, 0.48)) appendSample(brainPath, n);
    const r = calibratedThresholds(brainPath, 3, STATIC, { NFF_BRAIN_NOVELTY_THRESHOLDS: '0.2,0.9' });
    expect(r).toEqual({ thresholds: STATIC, calibrated: false, sampleCount: 0 });
  });

  it('NFF_BRAIN_NOVELTY_CALIBRATE=0 opts out entirely', () => {
    for (const n of spread(60, 0.36, 0.48)) appendSample(brainPath, n);
    const r = calibratedThresholds(brainPath, 3, STATIC, { NFF_BRAIN_NOVELTY_CALIBRATE: '0' });
    expect(r.calibrated).toBe(false);
    expect(r.thresholds).toEqual(STATIC);
  });
});
