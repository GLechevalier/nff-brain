import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CLIP_TEXT,
  appendClip,
  clipQueueStats,
  clipsPath,
  clipsProcessingPath,
  finishTake,
  normalizeClip,
  parseClipLines,
  readClips,
  takeClips,
} from '../src/index.js';
import type { AppendClipContext } from '../src/index.js';

let dir: string;
let brainPath: string;
const CTX: AppendClipContext = { target: 'global', source: 'chrome', clientId: 'cl_abc' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-clips-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function clip(over: Record<string, unknown> = {}) {
  return { kind: 'selection', text: 'a durable fact', url: 'https://example.com/a', title: 'A', ...over };
}

describe('normalizeClip', () => {
  const ctx = { id: 'clp_1_aa', at: new Date(0).toISOString(), target: 'global' as const, source: 'chrome' };

  it('keeps a well-formed clip and stamps server-side fields', () => {
    const r = normalizeClip(clip({ capturedAt: new Date(1000).toISOString() }), ctx)!;
    expect(r.v).toBe(1);
    expect(r.id).toBe('clp_1_aa');
    expect(r.at).toBe(ctx.at);
    expect(r.capturedAt).toBe(new Date(1000).toISOString());
    expect(r.kind).toBe('selection');
  });

  it('truncates text to the cap', () => {
    const r = normalizeClip(clip({ text: 'x'.repeat(MAX_CLIP_TEXT + 500) }), ctx)!;
    expect(r.text).toHaveLength(MAX_CLIP_TEXT);
  });

  it('accepts kind pagevisit', () => {
    const r = normalizeClip(clip({ kind: 'pagevisit' }), ctx)!;
    expect(r.kind).toBe('pagevisit');
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///c:/secrets.txt'],
    ['data:text/html,<h1>x'],
    ['not a url at all'],
  ])('drops the non-http url %j', (url) => {
    const r = normalizeClip(clip({ url }), ctx)!;
    expect(r.url).toBeUndefined();
    expect(r.text).toBe('a durable fact'); // …but keeps the text
  });

  it('strips control characters that would corrupt the JSONL', () => {
    const r = normalizeClip(clip({ text: 'a\u0000b\u001fc' }), ctx)!;
    expect(r.text).toBe('abc');
  });

  it('rejects an unknown kind', () => {
    expect(normalizeClip(clip({ kind: 'screenshot' }), ctx)).toBeNull();
    expect(normalizeClip(clip({ kind: undefined }), ctx)).toBeNull();
  });

  it('rejects a clip with neither text nor a usable url', () => {
    expect(normalizeClip({ kind: 'selection', text: '   ', url: 'javascript:x' }, ctx)).toBeNull();
  });

  it('drops unknown fields rather than echoing them into the queue', () => {
    const r = normalizeClip(clip({ evil: 'payload', cookies: 'x' }) as never, ctx)!;
    expect(r).not.toHaveProperty('evil');
    expect(r).not.toHaveProperty('cookies');
  });

  it('ignores an unparseable capturedAt claim', () => {
    expect(normalizeClip(clip({ capturedAt: 'yesterday' }), ctx)!.capturedAt).toBeUndefined();
  });

  it('records workspaceRoot only for a project-targeted clip', () => {
    expect(normalizeClip(clip(), { ...ctx, workspaceRoot: '/ws' })!.workspaceRoot).toBeUndefined();
    expect(
      normalizeClip(clip(), { ...ctx, target: 'project', workspaceRoot: '/ws' })!.workspaceRoot,
    ).toBe('/ws');
  });
});

describe('parseClipLines', () => {
  it('skips a torn tail, garbage, a future version and an unknown kind', () => {
    const good = JSON.stringify({ v: 1, id: 'clp_1_a', at: new Date(0).toISOString(), kind: 'selection', text: 'ok' });
    const chunk = [
      good,
      '{"v":2,"id":"x","at":"1970-01-01T00:00:00.000Z","kind":"selection","text":"future"}',
      '{"v":1,"id":"x","at":"1970-01-01T00:00:00.000Z","kind":"screenshot","text":"weird"}',
      '{"v":1,"id":"x","at":"not a date","kind":"selection","text":"bad date"}',
      'not json',
      '{"v":1,"id":"trunc"', // torn tail
    ].join('\n');
    const out = parseClipLines(chunk);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('ok');
  });
});

describe('append / read round trip', () => {
  it('appends and reads back', () => {
    const r = appendClip(brainPath, clip(), CTX);
    expect(r).toMatchObject({ ok: true, pending: 1 });
    const back = readClips(brainPath);
    expect(back).toHaveLength(1);
    expect(back[0]!.text).toBe('a durable fact');
    expect(back[0]!.clientId).toBe('cl_abc');
    expect(back[0]!.id).toMatch(/^clp_\d+_[0-9a-f]{6}$/);
  });

  it('reports invalid input without writing anything', () => {
    expect(appendClip(brainPath, { kind: 'nope' }, CTX)).toEqual({ ok: false, reason: 'invalid' });
    expect(fs.existsSync(clipsPath(brainPath))).toBe(false);
  });

  it('accepts a maximal ASCII clip — the per-field caps normally suffice', () => {
    const big = {
      kind: 'selection',
      text: 'x'.repeat(MAX_CLIP_TEXT + 100),
      url: `https://example.com/${'y'.repeat(2100)}`,
      title: 'z'.repeat(400),
    };
    expect(appendClip(brainPath, big, CTX).ok).toBe(true);
  });

  it('refuses a line that clears 16 KB despite the field caps, writing nothing', () => {
    // The per-field caps count UTF-16 units, so a fully CJK payload is roughly
    // three bytes per counted unit and slips past them. This is the backstop.
    const huge = {
      kind: 'selection',
      text: '漢'.repeat(MAX_CLIP_TEXT),
      url: `https://example.com/${'漢'.repeat(1900)}`,
      title: '漢'.repeat(300),
      note: '漢'.repeat(500),
    };
    const r = appendClip(brainPath, huge, CTX);
    expect(r).toEqual({ ok: false, reason: 'too_large' });
    expect(fs.existsSync(clipsPath(brainPath))).toBe(false);
  });

  it('refuses once the queue is full, leaving the file untouched', () => {
    const file = clipsPath(brainPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    const before = fs.statSync(file).size;

    const r = appendClip(brainPath, clip(), CTX);
    expect(r).toEqual({ ok: false, reason: 'queue_full' });
    expect(fs.statSync(file).size).toBe(before);
    expect(clipQueueStats(brainPath).full).toBe(true);
  });

  it('routes a project clip to the project brain dir', () => {
    const projectBrain = path.join(dir, 'ws', '.nff-brain', 'brain.json');
    appendClip(projectBrain, clip(), { target: 'project', source: 'chrome', workspaceRoot: path.join(dir, 'ws') });
    expect(fs.existsSync(clipsPath(projectBrain))).toBe(true);
    expect(fs.existsSync(clipsPath(brainPath))).toBe(false);
    expect(readClips(projectBrain)[0]!.workspaceRoot).toBe(path.join(dir, 'ws'));
  });
});

describe('two-phase drain', () => {
  it('claims the queue and lets new appends start a fresh file', () => {
    appendClip(brainPath, clip({ text: 'first' }), CTX);
    appendClip(brainPath, clip({ text: 'second' }), CTX);

    const taken = takeClips(brainPath);
    expect(taken.records.map((r) => r.text)).toEqual(['first', 'second']);
    expect(fs.existsSync(clipsPath(brainPath))).toBe(false);
    expect(fs.existsSync(clipsProcessingPath(brainPath))).toBe(true);

    appendClip(brainPath, clip({ text: 'third' }), CTX);
    expect(readClips(brainPath).map((r) => r.text)).toEqual(['third']);

    finishTake(taken.handle!);
    expect(fs.existsSync(clipsProcessingPath(brainPath))).toBe(false);
  });

  it('returns nothing for an empty queue', () => {
    expect(takeClips(brainPath)).toEqual({ records: [], handle: null });
  });

  it('re-delivers a batch whose drain never finished', () => {
    // AT-LEAST-ONCE. finishTake is deliberately not called, simulating a crash
    // between claiming the batch and committing the nodes it produced.
    appendClip(brainPath, clip({ text: 'first' }), CTX);
    takeClips(brainPath);

    appendClip(brainPath, clip({ text: 'second' }), CTX);
    const again = takeClips(brainPath);
    expect(again.records.map((r) => r.text)).toEqual(['first', 'second']);
    expect(fs.existsSync(clipsPath(brainPath))).toBe(false);
  });

  it('counts in-flight clips as still pending', () => {
    appendClip(brainPath, clip(), CTX);
    takeClips(brainPath);
    expect(clipQueueStats(brainPath).pending).toBe(1);
  });
});

describe('bulk appends', () => {
  it('leaves every line complete and parseable', () => {
    for (let i = 0; i < 100; i++) appendClip(brainPath, clip({ text: `n${i}` }), CTX);
    const raw = fs.readFileSync(clipsPath(brainPath), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(100);
    expect(parseClipLines(raw)).toHaveLength(100);
    expect(clipQueueStats(brainPath).pending).toBe(100);
  });

  // The genuine multi-PROCESS race lives in packages/cli/test/serveHttp.test.ts,
  // which fires concurrent POSTs at a running server. Reproducing it here would
  // mean spawning node against raw TS, which needs a loader this repo does not
  // carry — and the interesting contention is between HTTP handlers anyway.
});
