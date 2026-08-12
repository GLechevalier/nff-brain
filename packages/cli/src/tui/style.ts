// Colors and glyphs for the TUI — the first styled output in this repo, so
// the rules live here and nowhere else:
//
//  - FORCE_COLOR is checked BEFORE NO_COLOR (matching Node's own precedence).
//  - Never call getColorDepth() on win32: Node returns 24-bit for any Win10
//    build >= 14931, including a legacy conhost that renders 38;2;… poorly.
//    Truecolor is gated on WT_SESSION / vscode / ConEmu instead.
//  - Style functions use attribute-specific closes (22m/39m/27m), never a
//    mid-line 0m, so dim(accent(x)) nests correctly. Frames still terminate
//    every LINE with 0m before the erase (see frame.ts) for BCE terminals.

export type ColorLevel = 0 | 1 | 2 | 3; // none | 16 | 256 | 16m

export interface Style {
  readonly level: ColorLevel;
  dim(s: string): string;
  bold(s: string): string;
  accent(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  err(s: string): string;
  inverse(s: string): string;
}

export function detectColorLevel(env: NodeJS.ProcessEnv, isTTY: boolean, platform: NodeJS.Platform = process.platform): ColorLevel {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '' || force === '1' || force === 'true') return 1;
    if (force === '2') return 2;
    if (force === '3') return 3;
    return 0;
  }
  if (env.NO_COLOR !== undefined) return 0;
  if (env.NODE_DISABLE_COLORS !== undefined) return 0;
  if (env.TERM === 'dumb') return 0;
  if (!isTTY) return 0;
  if (platform === 'win32') {
    if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.ConEmuANSI === 'ON') return 3;
    return 1;
  }
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (/-256(color)?$/.test(env.TERM ?? '')) return 2;
  if (env.TERM) return 1;
  return 0;
}

// Claude's terracotta accent, one triple, one place.
const ACCENT: Record<Exclude<ColorLevel, 0>, string> = {
  1: '\x1b[33m',
  2: '\x1b[38;5;209m',
  3: '\x1b[38;2;217;119;87m',
};

function sgr(open: string, close: string): (s: string) => string {
  return (s) => `${open}${s}${close}`;
}

const identity = (s: string): string => s;

export function createStyle(level: ColorLevel): Style {
  if (level === 0) {
    // No-ops so tests can assert on plain strings.
    return { level, dim: identity, bold: identity, accent: identity, ok: identity, warn: identity, err: identity, inverse: identity };
  }
  return {
    level,
    dim: sgr('\x1b[2m', '\x1b[22m'),
    bold: sgr('\x1b[1m', '\x1b[22m'),
    accent: sgr(ACCENT[level], '\x1b[39m'),
    ok: sgr('\x1b[32m', '\x1b[39m'),
    warn: sgr('\x1b[33m', '\x1b[39m'),
    err: sgr('\x1b[31m', '\x1b[39m'),
    inverse: sgr('\x1b[7m', '\x1b[27m'),
  };
}

export interface Glyphs {
  cursor: string;
  check: string;
  cross: string;
  dot: string;
  arrow: string;
  branch: string; // provenance marker
  rule: string;
  more: string;
  boxOn: string;
  boxOff: string;
  spinner: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
  cursor: '❯',
  check: '✓',
  cross: '✗',
  dot: '·',
  arrow: '→',
  branch: '↳',
  rule: '─',
  more: '…',
  boxOn: '[x]', // ASCII on purpose: matches import-preview.md, unambiguous width
  boxOff: '[ ]',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const ASCII_GLYPHS: Glyphs = {
  cursor: '>',
  check: '+',
  cross: 'x',
  dot: '-',
  arrow: '->',
  branch: '\\',
  rule: '-',
  more: '...',
  boxOn: '[x]',
  boxOff: '[ ]',
  spinner: ['-', '\\', '|', '/'],
};

export function detectGlyphs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Glyphs {
  if (env.NFF_BRAIN_ASCII === '1') return ASCII_GLYPHS;
  if (env.NFF_BRAIN_UNICODE === '1') return UNICODE_GLYPHS;
  const unicode =
    platform !== 'win32' ||
    !!env.WT_SESSION ||
    env.TERM_PROGRAM === 'vscode' ||
    env.ConEmuANSI === 'ON' ||
    !!env.MSYSTEM ||
    /^xterm/.test(env.TERM ?? '');
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}
