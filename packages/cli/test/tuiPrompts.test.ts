// Integration through the REAL keypress decoder: readline.emitKeypressEvents
// on a PassThrough decodes the same byte sequences a terminal sends, so these
// tests exercise the actual arrow/enter/escape path, not a mock of it.

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTerm, type Term, type TermInput, type TermOutput } from '../src/tui/term.js';
import { confirm, select, text } from '../src/tui/prompts.js';
import { checklist } from '../src/tui/checklist.js';
import { stripAnsi } from '../src/tui/width.js';

function fakeTerm(o: { columns?: number; rows?: number; isTTY?: boolean } = {}) {
  const input = new PassThrough() as unknown as TermInput & PassThrough;
  (input as { isTTY?: boolean }).isTTY = o.isTTY ?? true;
  const raw: boolean[] = [];
  (input as { setRawMode?: (m: boolean) => unknown }).setRawMode = (m: boolean) => {
    raw.push(m);
    return input;
  };
  let sink = '';
  const output: TermOutput = {
    write: (s: string) => {
      sink += s;
      return true;
    },
    columns: o.columns ?? 80,
    rows: o.rows ?? 24,
    isTTY: o.isTTY ?? true,
  };
  const term: Term = createTerm({
    input,
    output,
    env: {},
    platform: 'linux',
    escapeCodeTimeout: 10, // fast lone-Esc decode in tests
  });
  return {
    term,
    raw,
    send: (s: string) => (input as PassThrough).write(s),
    get sink() {
      return sink;
    },
  };
}

const OPTS = [
  { value: 'a', label: 'Alpha', hint: '1 thing' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('select', () => {
  it('arrows down twice then enter picks the third option', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    t.send('\x1b[B\x1b[B\r');
    await expect(p).resolves.toBe('c');
    expect(t.sink).toContain('\x1b[?25h'); // cursor shown again
    expect(t.sink).not.toContain('\x1b[2J'); // never a full clear
    t.term.release();
    // Raw mode was entered once and restored by release() — the one teardown.
    expect(t.raw[0]).toBe(true);
    expect(t.raw.at(-1)).toBe(false);
  });

  it('number keys jump-select', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    t.send('2');
    await expect(p).resolves.toBe('b');
    t.term.release();
  });

  it('wraps upward from the first option', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    t.send('\x1b[A\r'); // up from index 0 → last
    await expect(p).resolves.toBe('c');
    t.term.release();
  });

  it('lone Esc cancels (after the escape timeout)', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    t.send('\x1b');
    await expect(p).resolves.toBeNull();
    t.term.release();
  });

  it('esc-then-ctrl-c inside the escape window still cancels (merged event)', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    t.send('\x1b\x03'); // one chunk → {meta:true, name:undefined}
    await expect(p).resolves.toBeNull();
    t.term.release();
  });

  it('renders the ❯ cursor on the highlighted row and dim hints', async () => {
    const t = fakeTerm();
    const p = select('pick one', OPTS, { term: t.term });
    await tick();
    const plain = stripAnsi(t.sink);
    expect(plain).toContain('❯ Alpha');
    expect(plain).toContain('1 thing');
    t.send('\r');
    await p;
    t.term.release();
  });

  it('returns the fallback on a non-TTY without writing or blocking', async () => {
    const t = fakeTerm({ isTTY: false });
    await expect(select('q', OPTS, { term: t.term, fallback: 'b' })).resolves.toBe('b');
    expect(t.sink).toBe('');
    t.term.release();
  });

  it('throws on a non-TTY with no fallback — rejection is the exit-1 path', async () => {
    const t = fakeTerm({ isTTY: false });
    await expect(select('q', OPTS, { term: t.term })).resolves.toBeNull();
    t.term.release();
  });
});

describe('text', () => {
  it('types, edits with backspace, submits', async () => {
    const t = fakeTerm();
    const p = text('since when?', { term: t.term });
    await tick();
    t.send('7dd\x7f\r'); // "7dd", backspace, enter
    await expect(p).resolves.toBe('7d');
    t.term.release();
  });

  it('empty submit returns the default', async () => {
    const t = fakeTerm();
    const p = text('since when?', { term: t.term, default: '30d' });
    await tick();
    t.send('\r');
    await expect(p).resolves.toBe('30d');
    t.term.release();
  });

  it('validate blocks a bad answer and accepts a fixed one', async () => {
    const t = fakeTerm();
    const p = text('since when?', { term: t.term, validate: (v) => (v === 'bad' ? 'nope' : undefined) });
    await tick();
    t.send('bad\r');
    await tick();
    expect(stripAnsi(t.sink)).toContain('nope');
    t.send('\x7f\x7f\x7f7d\r');
    await expect(p).resolves.toBe('7d');
    t.term.release();
  });
});

describe('confirm', () => {
  it('y decides immediately; enter takes the highlighted value', async () => {
    const t = fakeTerm();
    const p = confirm('sure?', { term: t.term });
    await tick();
    t.send('y');
    await expect(p).resolves.toBe(true);

    const t2 = fakeTerm();
    const p2 = confirm('sure?', { term: t2.term, initial: false });
    await tick();
    t2.send('\r');
    await expect(p2).resolves.toBe(false);
    t.term.release();
    t2.term.release();
  });
});

describe('checklist driver', () => {
  const SECTIONS = [
    {
      title: 'Durable memories',
      items: [
        { id: 'm1', title: 'Retry renameSync on EPERM', confidence: 0.65, body: 'Defender briefly locks the file.', checked: true },
        { id: 'm2', title: 'Low confidence thing', confidence: 0.4, checked: false },
      ],
    },
  ];

  it('space-toggle then enter returns the reviewed split', async () => {
    const t = fakeTerm();
    const p = checklist('review', SECTIONS, { term: t.term });
    await tick();
    t.send(' '); // uncheck m1
    await tick();
    t.send('\x1b[B \r'); // down, check m2, apply
    const r = await p;
    expect(r).toEqual({ checked: ['m2'], unchecked: ['m1'] });
    t.term.release();
    expect(t.raw[0]).toBe(true);
    expect(t.raw.at(-1)).toBe(false);
  });

  it('esc resolves null and leaves the terminal restored', async () => {
    const t = fakeTerm();
    const p = checklist('review', SECTIONS, { term: t.term });
    await tick();
    t.send('\x1b');
    await expect(p).resolves.toBeNull();
    expect(t.sink).toContain('\x1b[?25h');
    t.term.release();
  });
});
