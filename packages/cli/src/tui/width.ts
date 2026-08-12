// Display-cell math for ANSI-styled, LLM-authored text.
//
// Titles and bodies in the checklist come straight from `claude -p`, so they
// can carry emoji, CJK, combining marks. A single String#padEnd on such a
// string shifts every column below it — all padding in the TUI goes through
// displayWidth/padTo instead.

// SGR/CSI escape sequences (colors, cursor motion).
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Strip SGR/CSI so padding math works on styled strings. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Wide (2-cell) ranges — the common ones, not a full EastAsianWidth table. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK ext B+
  );
}

/** Zero-width: combining marks, ZWJ/ZWNJ, variation selectors. */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    cp === 0x200b || cp === 0x200c || cp === 0x200d || // ZWSP/ZWNJ/ZWJ
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/**
 * Display cells. Wide ranges count 2, zero-width 0, everything else 1.
 * East-Asian *Ambiguous* glyphs (✓ · → ❯ ▸ ─ …) deliberately count 1 — the
 * same assumption the repo's existing padEnd output already makes.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue; // control chars render nothing
    w += isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
  }
  return w;
}

/**
 * ANSI-aware truncate to `max` cells, appending `ellipsis` when it cuts.
 * Styled input keeps its escapes; a cut string gets a reset appended so an
 * open SGR can never bleed into what follows.
 */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (displayWidth(s) <= max) return s;
  const ellW = displayWidth(ellipsis);
  const budget = Math.max(0, max - ellW);
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const esc = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  const hadAnsi = out !== stripAnsi(out);
  return out + (hadAnsi ? '\x1b[0m' : '') + ellipsis;
}

/** Right-pad to `w` cells. NEVER use String#padEnd on LLM text. */
export function padTo(s: string, w: number): string {
  const d = w - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

/** Left-pad to `w` cells. */
export function padStartTo(s: string, w: number): string {
  const d = w - displayWidth(s);
  return d > 0 ? ' '.repeat(d) + s : s;
}

/** Greedy word wrap to `w` cells; splits over-long words. Never returns []. */
export function wrap(s: string, w: number): string[] {
  const width = Math.max(1, w);
  const out: string[] = [];
  for (const para of s.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      let piece = word;
      // A single word longer than the line gets hard-split.
      while (displayWidth(piece) > width) {
        const head = truncate(piece, width, '');
        const flushed = line ? `${line} ${head}` : head;
        if (displayWidth(flushed) > width && line) {
          out.push(line);
          line = '';
          continue;
        }
        out.push(flushed);
        line = '';
        piece = piece.slice(head.length);
      }
      if (!piece) continue;
      const joined = line ? `${line} ${piece}` : piece;
      if (displayWidth(joined) > width) {
        if (line) out.push(line);
        line = piece;
      } else {
        line = joined;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/** `left … right` with right-alignment within `w`; drops right if cramped. */
export function twoColumn(left: string, right: string, w: number, gap = 2): string {
  if (!right) return truncate(left, w);
  const rw = displayWidth(right);
  const lw = displayWidth(left);
  if (lw + gap + rw > w) {
    // Not enough room for both: prefer the label, drop the hint.
    if (rw + gap >= w) return truncate(left, w);
    return padTo(truncate(left, w - gap - rw), w - rw) + right;
  }
  return left + ' '.repeat(w - lw - rw) + right;
}
