// The redraw primitive: a live multi-line region at the bottom of the
// scrollback that can be repainted in place.
//
// Anti-flicker mechanism: every render builds ONE string and issues ONE
// write(). The terminal receives cursor-up + repaint + erase as an atomic
// chunk and paints once. (On Windows each write is a synchronous console
// round-trip, so per-op writes visibly tear.)
//
// Rules, each fixing a real corruption mode:
//  - relative motion only (CUU + \r); absolute CUP is wrong on Windows where
//    the console BUFFER is ~9001 rows but stdout.rows is the window height
//  - never \x1b[2J (destroys the scrollback the progress log depends on)
//  - each line ends 0m then 0K — reset before erase, or BCE terminals paint
//    the erased cells with the still-open background color
//  - no trailing \n after the last line, or the frame drifts up a row and
//    the next CUU count desyncs
//  - every line truncated to columns-1: a line exactly `columns` wide leaves
//    the terminal in pending-wrap state and the following \n may or may not
//    consume a row depending on the emulator
//  - taller-than-viewport frames are clamped with a "… N more" row; once the
//    terminal scrolls, CUU walks into rows we don't own
//
// While a frame is live, nothing else may write to the same stream.

import { truncate } from './width.js';
import type { Term } from './term.js';

export interface Frame {
  /** Replace the live region with `lines`. One write, no flicker. */
  render(lines: readonly string[]): void;
  /** Print permanent scrollback ABOVE the live region, then redraw it. */
  log(lines: readonly string[]): void;
  /** Erase the live region entirely (height → 0). */
  clear(): void;
  /** Erase, optionally print a final static block, restore the cursor. */
  close(final?: readonly string[]): void;
  /** Forget the recorded height without erasing — resize recovery. */
  reset(): void;
  readonly height: number;
}

export function createFrame(term: Term, opts: { maxHeight?: number } = {}): Frame {
  let height = 0;
  let last: readonly string[] = [];
  let closed = false;

  const offResize = term.onResize(() => {
    if (closed || !height) return;
    // The terminal reflowed rows we thought we owned; erasing with the stale
    // height would eat unrelated output. Forget it and repaint at the new
    // width — one stale copy may remain in scrollback, and that is the
    // honest trade-off of not using the alternate screen buffer.
    height = 0;
    frame.render(last);
  });

  function moveToTop(): string {
    return (height > 1 ? `\x1b[${height - 1}A` : '') + '\r';
  }

  function paint(lines: readonly string[]): string {
    const width = term.columns() - 1;
    const maxH = Math.min(opts.maxHeight ?? Infinity, term.rows() - 1);
    let rows = lines.map((l) => truncate(l, width, term.glyphs.more));
    if (rows.length > maxH) {
      const hidden = rows.length - (maxH - 1);
      rows = rows.slice(0, maxH - 1);
      rows.push(term.style.dim(truncate(`${term.glyphs.more} ${hidden} more`, width)));
    }
    let buf = moveToTop();
    for (let i = 0; i < rows.length; i++) {
      buf += rows[i] + '\x1b[0m\x1b[0K';
      if (i < rows.length - 1) buf += '\n';
    }
    buf += '\x1b[0J'; // drop a shrunken tail
    height = rows.length;
    return buf;
  }

  const frame: Frame = {
    get height() {
      return height;
    },
    render(lines) {
      if (closed || !term.isTTY) return;
      last = [...lines];
      if (height === 0) term.hideCursor();
      term.write(paint(last));
    },
    log(lines) {
      if (closed) return;
      if (!term.isTTY) {
        // Non-TTY: scrollback lines are the whole output, no live region.
        for (const l of lines) term.write(`${l}\n`);
        return;
      }
      const width = term.columns() - 1;
      let buf = moveToTop() + '\x1b[0J';
      for (const l of lines) buf += truncate(l, width, term.glyphs.more) + '\x1b[0m\n';
      height = 0;
      term.write(buf);
      if (last.length) term.write(paint(last));
    },
    clear() {
      if (closed || !term.isTTY || !height) return;
      term.write(moveToTop() + '\x1b[0J');
      height = 0;
    },
    close(final) {
      if (closed) return;
      frame.clear();
      closed = true;
      offResize();
      if (final?.length) {
        for (const l of final) term.write(`${l}\x1b[0m\n`);
      }
      term.showCursor();
    },
    reset() {
      height = 0;
    },
  };

  return frame;
}
