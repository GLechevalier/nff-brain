import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activityPath,
  appendActivity,
  breathePeriodMs,
  glowIntensity,
  parseActivityLines,
  readNewActivity,
  readRecentActivity,
  recomputeGlow,
  waveDelayMs,
  type Heat,
} from '../src/index.js';

let dir: string;
let brainPath: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-activity-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
  file = activityPath(brainPath);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function line(kind: string, ids: string[], at = '2026-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ v: 1, at, kind, ids }) + '\n';
}

describe('parseActivityLines', () => {
  it('parses valid lines and skips garbage, partial tails and unknown kinds', () => {
    const chunk =
      line('recall', ['a', 'b']) +
      'not json at all\n' +
      line('teleport', ['x']) + // future kind — dropped, not thrown
      JSON.stringify({ v: 2, at: '2026-01-01T00:00:00.000Z', kind: 'search', ids: ['y'] }) + '\n' + // future version
      line('search', ['c']) +
      '{"v":1,"at":"2026-01-01T00:'; // torn tail from a crashed writer
    const events = parseActivityLines(chunk);
    expect(events.map((e) => e.kind)).toEqual(['recall', 'search']);
    expect(events[0].ids).toEqual(['a', 'b']);
  });

  it('rejects events with a bad timestamp or non-string ids', () => {
    const chunk =
      JSON.stringify({ v: 1, at: 'yesterday-ish', kind: 'search', ids: ['a'] }) + '\n' +
      JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', kind: 'search', ids: [1, 2] }) + '\n';
    expect(parseActivityLines(chunk)).toHaveLength(0);
  });
});

describe('glow math', () => {
  it('glowIntensity is 1 at age 0, decays, and floors to 0', () => {
    expect(glowIntensity(0)).toBe(1);
    expect(glowIntensity(240_000)).toBeCloseTo(Math.exp(-1), 5);
    expect(glowIntensity(60 * 60_000)).toBe(0); // an hour later — fully cold
    expect(glowIntensity(-5)).toBe(0);
    expect(glowIntensity(Number.NaN)).toBe(0);
  });

  it('waveDelayMs uses a 120ms gap for small waves and caps the total for big ones', () => {
    expect(waveDelayMs(0, 5)).toBe(0);
    expect(waveDelayMs(3, 5)).toBe(360);
    // 100-node whole-graph wave: last node still starts within ~2.5s.
    expect(waveDelayMs(99, 100)).toBeLessThanOrEqual(2500);
  });

  it('breathePeriodMs slows from 2.4s (hot) to 6s (cold)', () => {
    expect(breathePeriodMs(1)).toBe(2400);
    expect(breathePeriodMs(0)).toBe(6000);
    expect(breathePeriodMs(0.5)).toBeGreaterThan(2400);
    expect(breathePeriodMs(0.5)).toBeLessThan(6000);
  });
});

describe('recomputeGlow', () => {
  it('decays a fresh touch, marks it fresh, and prunes it once cold', () => {
    const heat = new Map<string, Heat>([['a', { at: 0, base: 1, delayMs: 40 }]]);
    const hot = recomputeGlow(heat, 0);
    expect(hot.get('a')).toMatchObject({ intensity: 1, fresh: true, delayMs: 40, periodMs: 2400 });
    expect(heat.has('a')).toBe(true); // still tracked — not cold yet

    const stale = recomputeGlow(heat, 60 * 60_000); // an hour later
    expect(stale.has('a')).toBe(false);
    expect(heat.has('a')).toBe(false); // pruned from the source map too
  });

  it('is not fresh past GLOW_FRESH_MS', () => {
    const heat = new Map<string, Heat>([['a', { at: 0, base: 1, delayMs: 0 }]]);
    expect(recomputeGlow(heat, 5_000).get('a')?.fresh).toBe(false);
  });
});

describe('appendActivity + readNewActivity', () => {
  it('round-trips events and advances the offset incrementally', () => {
    appendActivity(brainPath, { kind: 'recall', ids: ['a', 'b'], seedCount: 1, sessionId: 's1' });
    appendActivity(brainPath, { kind: 'search', ids: ['c'] });

    const first = readNewActivity(file, 0);
    expect(first.events.map((e) => e.kind)).toEqual(['recall', 'search']);
    expect(first.events[0].seedCount).toBe(1);
    expect(first.events[0].sessionId).toBe('s1');
    expect(first.nextOffset).toBe(fs.statSync(file).size);

    // Nothing new → no events, offset stable.
    const again = readNewActivity(file, first.nextOffset);
    expect(again.events).toHaveLength(0);
    expect(again.nextOffset).toBe(first.nextOffset);

    // One more event → exactly one new event.
    appendActivity(brainPath, { kind: 'expand', ids: ['d'] });
    const delta = readNewActivity(file, first.nextOffset);
    expect(delta.events.map((e) => e.kind)).toEqual(['expand']);
  });

  it('does not advance past a partial (unterminated) tail line', () => {
    appendActivity(brainPath, { kind: 'search', ids: ['a'] });
    const complete = fs.statSync(file).size;
    fs.appendFileSync(file, '{"v":1,"at":"2026-'); // writer crashed mid-line
    const r = readNewActivity(file, 0);
    expect(r.events).toHaveLength(1);
    expect(r.nextOffset).toBe(complete); // parked before the torn tail
    // Writer finishes the line later → picked up from the parked offset.
    fs.appendFileSync(file, '01-01T00:00:00.000Z","kind":"expand","ids":["b"]}\n');
    const r2 = readNewActivity(file, r.nextOffset);
    expect(r2.events.map((e) => e.kind)).toEqual(['expand']);
  });

  it('resets to offset 0 when the file shrank (rotation/truncation)', () => {
    appendActivity(brainPath, { kind: 'search', ids: ['a'] });
    const bigOffset = fs.statSync(file).size + 10_000;
    const r = readNewActivity(file, bigOffset);
    expect(r.events.map((e) => e.ids[0])).toEqual(['a']); // re-read from the top
    expect(r.nextOffset).toBe(fs.statSync(file).size);
  });

  it('returns empty with offset 0 for a missing file', () => {
    expect(readNewActivity(file, 123)).toEqual({ events: [], nextOffset: 0 });
  });

  it('caps ids at 100 per event', () => {
    appendActivity(brainPath, { kind: 'recall', ids: Array.from({ length: 250 }, (_, i) => `n${i}`) });
    const r = readNewActivity(file, 0);
    expect(r.events[0].ids).toHaveLength(100);
  });

  it('rotates the live file to .old past the size cap', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = line('search', ['x'.repeat(200)]);
    const rounds = Math.ceil((260 * 1024) / filler.length);
    fs.writeFileSync(file, filler.repeat(rounds)); // > 256KB of valid lines
    appendActivity(brainPath, { kind: 'distill', ids: ['fresh'] });
    expect(fs.existsSync(`${file}.old`)).toBe(true);
    const live = readNewActivity(file, 0);
    expect(live.events.map((e) => e.kind)).toEqual(['distill']); // only post-rotation events
  });

  it('never throws on an unwritable path', () => {
    // A directory where the FILE should be → append fails internally.
    fs.mkdirSync(file, { recursive: true });
    expect(() => appendActivity(brainPath, { kind: 'search', ids: ['a'] })).not.toThrow();
  });
});

describe('readRecentActivity', () => {
  it('filters by age', () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const recent = new Date(Date.now() - 30_000).toISOString();
    appendActivity(brainPath, { kind: 'search', ids: ['old'], at: old });
    appendActivity(brainPath, { kind: 'search', ids: ['new'], at: recent });
    const events = readRecentActivity(file, 5 * 60_000);
    expect(events.map((e) => e.ids[0])).toEqual(['new']);
  });

  it('returns empty for a missing file', () => {
    expect(readRecentActivity(file, 60_000)).toEqual([]);
  });
});

describe('concurrent appends (O_APPEND line atomicity)', () => {
  it('two processes appending 200 lines each produce 400 parseable lines', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Children use the same syscall shape as appendActivity: one
    // appendFileSync per line. Interleaved LINES are fine; torn lines are not.
    const script =
      `const fs=require('node:fs');` +
      `for(let i=0;i<200;i++){fs.appendFileSync(process.argv[1],` +
      `JSON.stringify({v:1,at:new Date().toISOString(),kind:'search',ids:[process.argv[2]+i]})+'\\n');}`;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, file, 'p'], { stdio: 'ignore' });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.on('error', reject);
      });
    await Promise.all([run(), run()]);
    const events = parseActivityLines(fs.readFileSync(file, 'utf8'));
    expect(events).toHaveLength(400);
  }, 30_000);
});
