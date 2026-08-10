import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firstUserText, readTranscript } from '../src/index.js';

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
