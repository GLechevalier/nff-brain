// The injectable terminal seam — the only file that touches process.stdin's
// raw mode or calls readline.emitKeypressEvents.
//
// Governing constraint (same as util.ts readStdin): index.ts finishes every
// command with flushExit → process.exit, and stdin MUST be fully released
// first or the process hangs. release() below is the one teardown path:
// idempotent, synchronous, registered on process 'exit' so even a crash or a
// flushExit from elsewhere restores the user's terminal.
//
// While any frame is live, NOTHING else may write to the same stream — one
// stray console.error mid-render shifts every subsequent row.

import * as readline from 'node:readline';
import { createStyle, detectColorLevel, detectGlyphs, type Glyphs, type Style } from './style.js';
import { toKey, type Key, type NodeReadlineKey } from './keys.js';

const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';

export interface TermInput extends NodeJS.EventEmitter {
  setRawMode?(mode: boolean): unknown;
  isTTY?: boolean;
  resume(): unknown;
  pause(): unknown;
  unref?(): unknown;
}

export interface TermOutput {
  write(chunk: string): boolean;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?(ev: 'resize', fn: () => void): unknown;
  off?(ev: 'resize', fn: () => void): unknown;
}

export interface TermOptions {
  input?: TermInput;
  output?: TermOutput;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  escapeCodeTimeout?: number;
  columns?: number;
  rows?: number;
}

export interface Term {
  readonly isTTY: boolean;
  readonly style: Style;
  readonly glyphs: Glyphs;
  columns(): number;
  rows(): number;
  write(s: string): void;
  hideCursor(): void;
  showCursor(): void;
  /** Debounced (60 ms, unref'd). Returns an unsubscribe. */
  onResize(fn: () => void): () => void;
  onKey(fn: (k: Key) => void): () => void;
  /** Idempotent full teardown. Safe from `finally` and process 'exit'. */
  release(): void;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function createTerm(opts: TermOptions = {}): Term {
  const input = opts.input ?? (process.stdin as unknown as TermInput);
  const output = opts.output ?? (process.stderr as unknown as TermOutput);
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  // Both ends must be terminals: with `2>/dev/null` the prompts would eat
  // keys invisibly, so a redirected stderr means non-interactive.
  const isTTY = opts.isTTY ?? (input.isTTY === true && output.isTTY === true);

  const style = createStyle(detectColorLevel(env, isTTY, platform));
  const glyphs = detectGlyphs(env, platform);

  const keyListeners = new Set<(k: Key) => void>();
  const resizeListeners = new Set<() => void>();
  let resizeTimer: NodeJS.Timeout | undefined;
  let listening = false;
  let released = false;
  let cursorHidden = false;

  const onKeypress = (str: string | undefined, raw: NodeReadlineKey): void => {
    const key = toKey(str, raw);
    for (const fn of [...keyListeners]) fn(key);
  };

  const onResizeRaw = (): void => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const fn of [...resizeListeners]) fn();
    }, 60);
    resizeTimer.unref?.();
  };

  function startListening(): void {
    if (listening || !isTTY) return;
    listening = true;
    const escTimeout = opts.escapeCodeTimeout ?? (Number(env.NFF_BRAIN_ESC_TIMEOUT) || 75);
    // escapeCodeTimeout is sticky to the FIRST emitKeypressEvents call per
    // stream, which is why createTerm is the only caller in the repo.
    readline.emitKeypressEvents(input as unknown as NodeJS.ReadableStream, {
      escapeCodeTimeout: escTimeout,
    } as unknown as readline.Interface);
    if (typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(true);
      } catch {
        /* pipes have no raw mode */
      }
    }
    input.on('keypress', onKeypress);
    input.resume();
  }

  function release(): void {
    if (released) return;
    released = true;
    // 1. Own the display one last time while writes still work.
    if (cursorHidden) {
      try {
        output.write(SHOW_CURSOR);
      } catch {
        /* stream gone */
      }
    }
    // 2. Timers before listeners — a live timer outlives everything else.
    clearTimeout(resizeTimer);
    // 3. Our listeners.
    input.off('keypress', onKeypress);
    output.off?.('resize', onResizeRaw);
    // 4. Cooked mode BEFORE pause; guard with typeof (undefined on pipes).
    if (input.isTTY && typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(false);
      } catch {
        /* already closed */
      }
    }
    // 5. MANDATORY: emitKeypressEvents' internal data handler is never
    //    removed, so without pause() stdin stays flowing and the process
    //    hangs — the util.ts:56 hazard.
    input.pause();
    input.unref?.();
    // 6. Process-level hooks.
    process.off('SIGINT', onSigint);
    process.off('exit', release);
  }

  const onSigint = (): void => {
    // Net for `kill -INT` and the windows outside raw mode; in raw mode
    // Ctrl-C arrives as byte 0x03 and widgets handle it as a key.
    release();
    process.exit(130);
  };

  if (isTTY) {
    process.once('exit', release);
    process.on('SIGINT', onSigint);
    output.on?.('resize', onResizeRaw);
  }

  return {
    isTTY,
    style,
    glyphs,
    columns: () => clamp(opts.columns ?? output.columns ?? 80, 20, 200),
    rows: () => clamp(opts.rows ?? output.rows ?? 24, 6, 200),
    write: (s) => {
      if (!released) output.write(s);
    },
    hideCursor: () => {
      if (isTTY && !released) {
        cursorHidden = true;
        output.write(HIDE_CURSOR);
      }
    },
    showCursor: () => {
      if (isTTY && !released) {
        cursorHidden = false;
        output.write(SHOW_CURSOR);
      }
    },
    onResize: (fn) => {
      resizeListeners.add(fn);
      return () => resizeListeners.delete(fn);
    },
    onKey: (fn) => {
      startListening();
      keyListeners.add(fn);
      return () => keyListeners.delete(fn);
    },
    release,
  };
}
