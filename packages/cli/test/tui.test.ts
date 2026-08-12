import { describe, expect, it } from 'vitest';
import { displayWidth, padTo, stripAnsi, truncate, twoColumn, wrap } from '../src/tui/width.js';
import { createStyle, detectColorLevel, detectGlyphs } from '../src/tui/style.js';
import { createFrame } from '../src/tui/frame.js';
import { createTerm, type TermInput, type TermOutput } from '../src/tui/term.js';
import { PassThrough } from 'node:stream';

describe('width', () => {
  it('strips ANSI before measuring', () => {
    expect(stripAnsi('\x1b[2mdim\x1b[22m')).toBe('dim');
    expect(displayWidth('\x1b[31mred\x1b[39m')).toBe(3);
  });

  it('counts wide and zero-width code points', () => {
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('á')).toBe(1); // combining accent
    expect(displayWidth('🧠')).toBe(2);
  });

  it('pads by display cells, not code units — the emoji-title bug', () => {
    // String#padEnd would give these different visual widths.
    expect(displayWidth(padTo('🧠 brain', 12))).toBe(12);
    expect(displayWidth(padTo('plain ti', 12))).toBe(12);
  });

  it('truncates with an ellipsis and closes open styles', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hi', 8)).toBe('hi');
    const cut = truncate('\x1b[31mhello world\x1b[39m', 8);
    expect(cut.endsWith('\x1b[0m…')).toBe(true);
  });

  it('wraps greedily and splits over-long words', () => {
    expect(wrap('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd']);
    expect(wrap('abcdefghij', 4).every((l) => displayWidth(l) <= 4)).toBe(true);
    expect(wrap('', 10)).toEqual(['']);
  });

  it('right-aligns the hint, truncating the label when cramped', () => {
    expect(twoColumn('label', 'hint', 20)).toBe('label           hint');
    const cramped = twoColumn('a-very-long-label-here', 'hint', 10);
    expect(displayWidth(cramped)).toBeLessThanOrEqual(10);
    expect(cramped).toContain('hint'); // the hint survives; the label gives way
    // Only when the hint itself cannot fit does it get dropped.
    expect(twoColumn('label', 'a-very-long-hint', 8)).not.toContain('hint');
  });
});

describe('detectColorLevel', () => {
  it('FORCE_COLOR wins over NO_COLOR (Node precedence)', () => {
    expect(detectColorLevel({ FORCE_COLOR: '1', NO_COLOR: '1' }, false, 'linux')).toBe(1);
    expect(detectColorLevel({ FORCE_COLOR: '3' }, false, 'linux')).toBe(3);
  });

  it('NO_COLOR, TERM=dumb and non-TTY all disable color', () => {
    expect(detectColorLevel({ NO_COLOR: '' }, true, 'linux')).toBe(0);
    expect(detectColorLevel({ TERM: 'dumb' }, true, 'linux')).toBe(0);
    expect(detectColorLevel({ TERM: 'xterm-256color' }, false, 'linux')).toBe(0);
  });

  it('win32 gates truecolor on the terminal host, never getColorDepth', () => {
    expect(detectColorLevel({ WT_SESSION: 'x' }, true, 'win32')).toBe(3);
    expect(detectColorLevel({ TERM_PROGRAM: 'vscode' }, true, 'win32')).toBe(3);
    expect(detectColorLevel({}, true, 'win32')).toBe(1); // legacy conhost
  });

  it('POSIX ladder: COLORTERM → 256 suffix → TERM', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor', TERM: 'xterm' }, true, 'linux')).toBe(3);
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true, 'linux')).toBe(2);
    expect(detectColorLevel({ TERM: 'xterm' }, true, 'linux')).toBe(1);
  });
});

describe('style + glyphs', () => {
  it('level 0 styles are identity so tests assert plain strings', () => {
    const st = createStyle(0);
    expect(st.accent('x')).toBe('x');
    expect(st.dim('x')).toBe('x');
  });

  it('styles use attribute-specific closes, never a mid-string full reset', () => {
    const st = createStyle(3);
    expect(st.dim('x')).toBe('\x1b[2mx\x1b[22m');
    expect(st.accent('x').endsWith('\x1b[39m')).toBe(true);
    expect(st.dim(st.accent('x'))).not.toContain('\x1b[0m');
  });

  it('glyphs fall back to ASCII on bare win32, unicode in Windows Terminal', () => {
    expect(detectGlyphs({}, 'win32').cursor).toBe('>');
    expect(detectGlyphs({ WT_SESSION: 'x' }, 'win32').cursor).toBe('❯');
    expect(detectGlyphs({}, 'linux').cursor).toBe('❯');
    expect(detectGlyphs({ NFF_BRAIN_ASCII: '1' }, 'linux').cursor).toBe('>');
  });

  it('checkboxes are ASCII everywhere — they must match the preview file', () => {
    expect(detectGlyphs({}, 'linux').boxOn).toBe('[x]');
    expect(detectGlyphs({}, 'win32').boxOff).toBe('[ ]');
  });
});

function fakeIo(o: { columns?: number; rows?: number; isTTY?: boolean } = {}) {
  const input = new PassThrough() as unknown as TermInput;
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
  return { input, output, raw, get sink() { return sink; }, clearSink: () => (sink = '') };
}

describe('frame', () => {
  it('renders in one write with relative motion, never a full clear', () => {
    const io = fakeIo({ columns: 40 });
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(['one', 'two']);
    frame.render(['three']);
    expect(io.sink).not.toContain('\x1b[2J');
    expect(io.sink).toContain('\x1b[1A'); // cursor-up by height-1
    expect(io.sink).toContain('\x1b[0J'); // shrink erase
    term.release();
  });

  it('never emits a content line as wide as the terminal', () => {
    const io = fakeIo({ columns: 30 });
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(['x'.repeat(200)]);
    const lines = stripAnsi(io.sink).split('\n');
    for (const l of lines) expect(displayWidth(l.replace(/\r/g, ''))).toBeLessThan(30);
    term.release();
  });

  it('clamps content taller than the viewport with a "more" row', () => {
    const io = fakeIo({ rows: 8 });
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(Array.from({ length: 30 }, (_, i) => `line ${i}`));
    expect(frame.height).toBeLessThanOrEqual(7);
    expect(stripAnsi(io.sink)).toContain('more');
    term.release();
  });

  it('log() prints scrollback above and repaints the live region', () => {
    const io = fakeIo();
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(['status']);
    io.clearSink();
    frame.log(['done: alpha']);
    const s = stripAnsi(io.sink);
    expect(s.indexOf('done: alpha')).toBeLessThan(s.indexOf('status'));
    term.release();
  });

  it('close() restores the cursor', () => {
    const io = fakeIo();
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(['x']);
    frame.close(['final']);
    expect(io.sink).toContain('\x1b[?25l');
    expect(io.sink).toContain('\x1b[?25h');
    expect(stripAnsi(io.sink)).toContain('final');
    term.release();
  });

  it('is inert on a non-TTY — no escapes at all', () => {
    const io = fakeIo({ isTTY: false });
    const term = createTerm({ input: io.input, output: io.output, env: {}, platform: 'linux' });
    const frame = createFrame(term);
    frame.render(['x']);
    frame.clear();
    expect(io.sink).toBe('');
    term.release();
  });
});
