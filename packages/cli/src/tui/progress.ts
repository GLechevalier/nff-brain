// Live progress for the mining fan-out: completed sessions scroll above as
// permanent log lines, a redrawing status region (spinner + counters +
// active labels) sits below.
//
// Non-TTY contract: log() writes exactly one plain line to the stream and
// update() is a no-op — byte-identical to today's note() output, which is
// what keeps e2eImport's piped assertions green.

import { createFrame, type Frame } from './frame.js';
import { truncate } from './width.js';
import type { Term } from './term.js';

export interface ProgressState {
  total: number;
  done: number;
  active: readonly string[];
  failed?: number;
  note?: string;
}

export interface ProgressHandle {
  /** Permanent scrollback line, printed above the live status. */
  log(line: string): void;
  update(patch: Partial<ProgressState>): void;
  /** Erases the status, prints `final` if given. */
  stop(final?: string): void;
}

export function progress(init: ProgressState, opts: { term: Term; label?: string }): ProgressHandle {
  const { term } = opts;
  const state: ProgressState = { ...init };
  const label = opts.label ?? 'working';

  if (!term.isTTY) {
    return {
      log: (line) => term.write(`${line}\n`),
      update: () => {},
      stop: (final) => {
        if (final) term.write(`${final}\n`);
      },
    };
  }

  const { style: st, glyphs: g } = term;
  const frame: Frame = createFrame(term, { maxHeight: 3 });
  let tick = 0;
  let stopped = false;

  const view = (): string[] => {
    const spin = st.accent(g.spinner[tick % g.spinner.length]);
    const failed = state.failed ? st.err(` ${g.dot} ${state.failed} failed`) : '';
    const lines = [`${spin} ${label}   ${st.bold(`${state.done}/${state.total}`)}${failed}${state.note ? st.dim(`  ${state.note}`) : ''}`];
    if (state.active.length) {
      const shown = state.active.slice(0, 3).join(', ') + (state.active.length > 3 ? `, +${state.active.length - 3}` : '');
      lines.push(st.dim(`  ${g.dot} ${truncate(shown, term.columns() - 5)}`));
    }
    return lines;
  };

  // The interval repaints; update() only mutates state. Repainting per event
  // at concurrency 4+ would strobe.
  const timer = setInterval(() => {
    if (stopped) return;
    tick++;
    frame.render(view());
  }, 80);
  timer.unref();

  frame.render(view());

  return {
    log(line) {
      if (stopped) return;
      frame.log([line]);
      frame.render(view());
    },
    update(patch) {
      if (stopped) return;
      Object.assign(state, patch);
      frame.render(view());
    },
    stop(final) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      frame.close(final !== undefined ? [final] : undefined);
    },
  };
}
