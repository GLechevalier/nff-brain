// Threshold calibration — cuts derived from THIS brain's own novelty
// distribution instead of two hardcoded constants.
//
// Why: novelty is not an absolute quantity. It depends on how big and how
// well-connected the graph is, so the same 0.35/0.7 cuts mean different things
// on a 10-node brain and a 400-node one. Measured on the real nff_cli_mcp brain
// every live session scored 0.36–0.48 — clustered right around the lower cut,
// so the ladder never discriminated and everything landed on the middle tier.
//
// Fix: keep a rolling sample of recent novelty scores and place the cuts at
// quantiles of it. "The most novel 15% of prompts get the frontier model" is a
// statement that stays true as the graph grows; "novelty > 0.7" does not.
//
// Static thresholds remain the fallback: too few samples, a degenerate
// distribution, or an explicit opt-out all return them unchanged. Calibration
// can only ever move the cuts, never break the ladder.

import * as fs from 'node:fs';
import { brainLogPath } from './paths.js';
import { writeFileAtomic } from './store.js';

export const SAMPLES_FILE = 'novelty-samples.json';

/** Ring-buffer depth. ~200 prompts ≈ several weeks of real use. */
export const MAX_SAMPLES = 200;

/** Below this, the distribution is noise — keep the static cuts. */
export const MIN_SAMPLES_TO_CALIBRATE = 25;

/**
 * Default cut points for a 3-tier ladder: the routine bottom half runs cheap,
 * the frontier is reserved for the genuinely unusual top 15%.
 */
export const DEFAULT_QUANTILES = [0.5, 0.85] as const;

export interface SamplesFile {
  version: 1;
  samples: number[]; // oldest → newest
}

export function samplesPath(brainPath: string): string {
  return brainLogPath(brainPath, SAMPLES_FILE);
}

export function readSamples(brainPath: string): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(samplesPath(brainPath), 'utf8')) as SamplesFile;
    if (!parsed || !Array.isArray(parsed.samples)) return [];
    return parsed.samples.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
  } catch {
    return []; // absent or malformed — no history, static cuts
  }
}

/** Append one observation, keeping the newest MAX_SAMPLES. Never throws. */
export function appendSample(brainPath: string, novelty: number, max = MAX_SAMPLES): void {
  try {
    if (!Number.isFinite(novelty)) return;
    const samples = [...readSamples(brainPath), Math.min(1, Math.max(0, novelty))].slice(-max);
    // Shares store.ts's Windows EPERM/EBUSY rename retry.
    writeFileAtomic(samplesPath(brainPath), JSON.stringify({ version: 1, samples } satisfies SamplesFile) + '\n');
  } catch {
    /* fail-open: calibration telemetry must never break a hook */
  }
}

/** Linear-interpolated quantile of an already-sorted ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Cuts at the given quantiles of the observed distribution, or null when the
 * samples cannot support a usable ladder. Pure.
 *
 * Returns null (→ caller keeps the static cuts) when there are too few samples,
 * or when the quantiles are not STRICTLY ascending — a flat distribution would
 * otherwise collapse two cuts onto the same value and make a tier unreachable.
 */
export function quantileThresholds(
  samples: readonly number[],
  tierCount: number,
  quantiles: readonly number[] = DEFAULT_QUANTILES,
  minSamples = MIN_SAMPLES_TO_CALIBRATE,
): number[] | null {
  const needed = tierCount - 1;
  if (needed < 1 || samples.length < minSamples || quantiles.length !== needed) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const cuts = quantiles.map((q) => quantile(sorted, q));
  for (let i = 0; i < cuts.length; i++) {
    // Must stay a usable ladder: strictly ascending and strictly inside (0,1).
    if (!(cuts[i] > 0 && cuts[i] < 1)) return null;
    if (i > 0 && !(cuts[i] > cuts[i - 1])) return null;
  }
  return cuts;
}

/** Quantiles from the environment, same silent-fallback stance as the rest. */
export function calibrationQuantiles(
  tierCount: number,
  env: Record<string, string | undefined> = process.env,
): number[] {
  const needed = tierCount - 1;
  const raw = env.NFF_BRAIN_NOVELTY_QUANTILES;
  if (raw) {
    const parsed = raw.split(',').map((s) => Number(s.trim()));
    const ok =
      parsed.length === needed &&
      parsed.every((n, i) => Number.isFinite(n) && n > 0 && n < 1 && (i === 0 || n > parsed[i - 1]));
    if (ok) return parsed;
  }
  return needed === DEFAULT_QUANTILES.length
    ? [...DEFAULT_QUANTILES]
    : Array.from({ length: needed }, (_, i) => (i + 1) / (needed + 1));
}

export interface CalibrationResult {
  thresholds: number[];
  calibrated: boolean; // false ⇒ these are the static cuts
  sampleCount: number;
}

/**
 * The one call sites use: static cuts in, calibrated cuts out (when the data
 * supports it). `NFF_BRAIN_NOVELTY_CALIBRATE=0` opts out entirely.
 */
export function calibratedThresholds(
  brainPath: string,
  tierCount: number,
  staticThresholds: number[],
  env: Record<string, string | undefined> = process.env,
): CalibrationResult {
  if (env.NFF_BRAIN_NOVELTY_CALIBRATE === '0') {
    return { thresholds: staticThresholds, calibrated: false, sampleCount: 0 };
  }
  // An explicit threshold override is the user speaking — never override it.
  if (env.NFF_BRAIN_NOVELTY_THRESHOLDS) {
    return { thresholds: staticThresholds, calibrated: false, sampleCount: 0 };
  }
  const samples = readSamples(brainPath);
  const cuts = quantileThresholds(samples, tierCount, calibrationQuantiles(tierCount, env));
  return {
    thresholds: cuts ?? staticThresholds,
    calibrated: cuts !== null,
    sampleCount: samples.length,
  };
}
