// Pure argv→plan logic for `nff-brain import`, shared by the classic path
// and the wizard. No I/O, no printing.

import type { Args } from '../util.js';
import { flagNum, flagStr } from '../util.js';
import { resolveBrainPaths } from '@nff-brain/core';

export const DEFAULT_LIMIT = 40;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** `7d` / `48h` / `3w` / an ISO date → epoch ms, or null when unparseable. */
export function parseSince(value: string, now = new Date()): number | null {
  const rel = value.trim().match(/^(\d+)\s*([dhw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'h' ? 3_600_000 : unit === 'w' ? 7 * 86_400_000 : 86_400_000;
    return now.getTime() - n * ms;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function estimateMinutes(sessions: number, concurrency: number): string {
  const seconds = Math.ceil((sessions / concurrency) * 25);
  if (seconds < 90) return `${seconds}s`;
  return `about ${Math.max(1, Math.round(seconds / 60))} minute${seconds >= 90 ? 's' : ''}`;
}

export interface ImportPlan {
  paths: ReturnType<typeof resolveBrainPaths>;
  target: string;
  minConfidence: number;
  limit: number;
  concurrency: number;
  force: boolean;
  all: boolean;
  yes: boolean;
  project?: string;
  sinceRaw?: string;
  sinceMs: number | null;
  model?: string;
}

export function planFromArgs(args: Args): ImportPlan {
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const minConfidence = flagNum(args, 'min-confidence') ?? DEFAULT_MIN_CONFIDENCE;
  const limit = flagNum(args, 'limit') ?? DEFAULT_LIMIT;
  const concurrency = Math.min(8, Math.max(1, flagNum(args, 'concurrency') ?? DEFAULT_CONCURRENCY));

  const sinceRaw = flagStr(args, 'since');
  let sinceMs: number | null = null;
  if (sinceRaw) {
    sinceMs = parseSince(sinceRaw);
    if (sinceMs === null) throw new Error(`could not read --since "${sinceRaw}" — try 7d, 48h, 3w or 2026-07-01`);
  }

  return {
    paths,
    target,
    minConfidence,
    limit,
    concurrency,
    force: args.flags.force === true,
    all: args.flags.all === true,
    yes: args.flags.yes === true,
    project: flagStr(args, 'project'),
    sinceRaw,
    sinceMs,
    model: flagStr(args, 'model'),
  };
}

export interface GateInput {
  args: Args;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Bare `nff-brain import` in a real terminal opens the wizard; anything else
 * falls through to the classic flag-driven path, byte for byte.
 *
 * Allowlist-free on purpose: ANY flag or positional closes the gate, so a
 * future flag can never silently open the wizard, and a value flag mis-parsed
 * as boolean (the VALUE_FLAGS trap in util.ts) still registers a key and
 * closes it too.
 */
export function shouldRunWizard(g: GateInput): boolean {
  if (Object.keys(g.args.flags).length > 0) return false;
  if (g.args.positional.length > 0) return false;
  if (!g.stdinTTY || !g.stdoutTTY || !g.stderrTTY) return false;
  const env = g.env;
  if (env.NFF_BRAIN_SKIP) return false; // spawned by our own claude -p
  if (env.CI) return false;
  if (env.TERM === 'dumb') return false;
  if (env.NFF_BRAIN_NO_TTY) return false;
  return true;
}
