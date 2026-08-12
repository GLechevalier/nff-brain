import { describe, expect, it } from 'vitest';
import { planFromArgs } from '../src/commands/importPlan.js';
import { classifyEmptyScan, emptyScanLines } from '../src/commands/importEngine.js';
import { parseArgs } from '../src/util.js';
import type { DiscoverResult } from '@nff-brain/core';

const found = (over: Partial<DiscoverResult['skipped']> = {}, scanned = { dirs: 3, files: 9 }): DiscoverResult => ({
  sessions: [],
  scanned,
  skipped: { oneshot: 0, short: 0, live: 0, sidechain: 0, old: 0, alreadyImported: 0, ...over },
  byProject: [],
  projectsDir: '/fake/.claude/projects',
});

describe('planFromArgs', () => {
  it('applies the documented defaults', () => {
    const p = planFromArgs(parseArgs([]));
    expect(p.limit).toBe(40);
    expect(p.concurrency).toBe(4);
    expect(p.minConfidence).toBe(0.5);
    expect(p.sinceMs).toBeNull();
    expect(p.all).toBe(false);
  });

  it('clamps concurrency to [1, 8]', () => {
    expect(planFromArgs(parseArgs(['--concurrency', '99'])).concurrency).toBe(8);
    expect(planFromArgs(parseArgs(['--concurrency', '0'])).concurrency).toBe(1);
  });

  it('throws the exact --since complaint on nonsense', () => {
    expect(() => planFromArgs(parseArgs(['--since', 'last tuesday']))).toThrow(
      'could not read --since "last tuesday" — try 7d, 48h, 3w or 2026-07-01',
    );
  });
});

describe('classifyEmptyScan ladder', () => {
  it('already-imported outranks oneshot — a folder routinely has both', () => {
    // The ordering comment in the original reportEmptyScan, now enforced.
    const r = classifyEmptyScan(found({ alreadyImported: 5, oneshot: 3 }), '/ws', 0);
    expect(r.kind).toBe('already-imported');
  });

  it('walks every rung in order', () => {
    expect(classifyEmptyScan(found({ oneshot: 2 }), '/ws', 0).kind).toBe('oneshot-only');
    expect(classifyEmptyScan(found({}, { dirs: 0, files: 0 }), '/ws', 0).kind).toBe('no-history');
    expect(classifyEmptyScan(found(), '/ws', 7).kind).toBe('cleared-history');
    expect(classifyEmptyScan(found(), '/ws', 0).kind).toBe('never-worked-here');
  });
});

describe('emptyScanLines — string-for-string with the classic output', () => {
  it('already-imported', () => {
    expect(emptyScanLines({ kind: 'already-imported', count: 5 })).toEqual([
      'no new sessions since the last import (5 already mined).',
      'use --force to re-scan them.',
    ]);
  });

  it('oneshot-only', () => {
    expect(emptyScanLines({ kind: 'oneshot-only', count: 3 })).toEqual([
      'the only transcripts for this folder are 3 one-shot `claude -p` run(s) — nothing to import.',
    ]);
  });

  it('no-history', () => {
    expect(emptyScanLines({ kind: 'no-history', projectsDir: '/x/projects' })).toEqual([
      'no Claude Code history at /x/projects',
      'set NFF_BRAIN_CLAUDE_HOME if your config lives elsewhere.',
    ]);
  });

  it('cleared-history', () => {
    expect(emptyScanLines({ kind: 'cleared-history', workspaceRoot: '/ws', prompts: 7 })).toEqual([
      'no transcripts for /ws, though history.jsonl remembers 7 prompt(s) here —',
      'your transcripts may have been cleared.',
    ]);
  });

  it('never-worked-here', () => {
    expect(emptyScanLines({ kind: 'never-worked-here', workspaceRoot: '/ws' })).toEqual([
      'no past sessions found for /ws.',
      'try --all to sweep every project, or --project <path>.',
    ]);
  });
});
