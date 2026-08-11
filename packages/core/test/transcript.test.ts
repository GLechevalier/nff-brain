import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firstUserText, readTranscript, readTranscriptWindow } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-transcript-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the login bug please' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking at the auth module now.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'x' } },
      ],
    },
  }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'big dump' }] } }),
  'not json at all',
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the cookie was http-only.' }] } }),
].join('\n');

describe('transcript', () => {
  it('extracts user/assistant text, skipping tool blocks and junk lines', () => {
    const p = path.join(dir, 't.jsonl');
    fs.writeFileSync(p, FIXTURE);
    const out = readTranscript(p);
    expect(out).toContain('[user] Fix the login bug please');
    expect(out).toContain('[assistant] Looking at the auth module now.');
    expect(out).toContain('cookie was http-only');
    expect(out).not.toContain('big dump');
    expect(out).not.toContain('not json');
  });

  it('tail-caps long transcripts', () => {
    const p = path.join(dir, 't.jsonl');
    const lines = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `message number ${i} ${'x'.repeat(100)}` } }),
    );
    fs.writeFileSync(p, lines.join('\n'));
    const out = readTranscript(p, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain('message number 199'); // kept the tail
  });

  it('firstUserText returns the opening request', () => {
    const p = path.join(dir, 't.jsonl');
    fs.writeFileSync(p, FIXTURE);
    expect(firstUserText(p)).toBe('Fix the login bug please');
  });

  it('is empty for a missing file', () => {
    expect(readTranscript(path.join(dir, 'nope.jsonl'))).toBe('');
  });
});

describe('readTranscriptWindow', () => {
  function bigTranscript(count: number, pad = 400): string {
    return Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `turn number ${i} ${'x'.repeat(pad)}`,
        },
      }),
    ).join('\n');
  }

  it('keeps BOTH ends — the head is what readTranscript throws away', () => {
    const p = path.join(dir, 'big.jsonl');
    fs.writeFileSync(p, bigTranscript(400));
    const out = readTranscriptWindow(p, { headChars: 2_000, tailChars: 2_000 });
    expect(out).toContain('turn number 0'); // decisions/preferences live here
    expect(out).toContain('turn number 399'); // conclusions live here
    expect(out).toContain('omitted'); // and the middle is marked as dropped
    // For contrast: the tail-capped reader loses the opening entirely.
    expect(readTranscript(p, 2_000)).not.toContain('turn number 0');
  });

  it('reads a file far larger than its byte windows without loading it whole', () => {
    const p = path.join(dir, 'huge.jsonl');
    fs.writeFileSync(p, bigTranscript(3_000, 500)); // ~1.5 MB
    const out = readTranscriptWindow(p, {
      headChars: 1_000,
      tailChars: 1_000,
      headBytes: 64 * 1024,
      tailBytes: 64 * 1024,
    });
    expect(out).toContain('turn number 0');
    expect(out).toContain('turn number 2999');
    expect(out.length).toBeLessThan(4_000);
  });

  it('returns a short transcript whole, with no omission marker', () => {
    const p = path.join(dir, 'small.jsonl');
    fs.writeFileSync(p, FIXTURE);
    const out = readTranscriptWindow(p);
    expect(out).toContain('[user] Fix the login bug please');
    expect(out).toContain('cookie was http-only');
    expect(out).not.toContain('omitted');
  });

  it('drops the partial lines at both window boundaries', () => {
    const p = path.join(dir, 'partial.jsonl');
    fs.writeFileSync(p, bigTranscript(200));
    // Tiny byte windows guarantee both boundaries land mid-record; a partial
    // line that reached the JSON parser would be silently skipped anyway, so
    // what this really asserts is that nothing garbled leaks into the output.
    const out = readTranscriptWindow(p, { headBytes: 2_000, tailBytes: 2_000 });
    for (const line of out.split('\n')) {
      expect(line === '… (middle of session omitted) …' || /^\[(user|assistant)\] /.test(line)).toBe(true);
    }
  });

  it('is empty for a missing file', () => {
    expect(readTranscriptWindow(path.join(dir, 'nope.jsonl'))).toBe('');
  });
});
