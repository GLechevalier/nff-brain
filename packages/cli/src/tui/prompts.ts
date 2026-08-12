// select / text / confirm — the question widgets.
//
// Contract shared by all three:
//  - resolve to the value, or null on Esc / Ctrl-C / Ctrl-D
//  - on a non-TTY, resolve `fallback` if given, else THROW (index.ts only
//    exits non-zero on a rejection); never block waiting on a pipe
//  - all chrome goes to the term's stream (stderr by default)

import { toKey, isCancel, isDown, isSubmit, isUp, type Key } from './keys.js';
import { createFrame } from './frame.js';
import { twoColumn, truncate } from './width.js';
import type { Term } from './term.js';

export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface PromptOpts {
  term: Term;
  fallback?: unknown;
}

function nonInteractive<T>(term: Term, question: string, fallback: T | undefined): T {
  if (fallback !== undefined) return fallback;
  throw new Error(`"${question}" needs an interactive terminal — re-run in a TTY or pass flags instead`);
}

/** Run a keypress-driven widget: render on every key until done(key) settles. */
function drive<T>(
  term: Term,
  view: () => string[],
  onKey: (k: Key) => { done: true; value: T } | { done: false },
  final?: (value: T) => string[] | undefined,
): Promise<T> {
  const frame = createFrame(term);
  return new Promise<T>((resolve) => {
    const off = term.onKey((k) => {
      const r = onKey(k);
      if (r.done) {
        off();
        frame.close(final?.(r.value));
        resolve(r.value);
        return;
      }
      frame.render(view());
    });
    frame.render(view());
  });
}

export async function select<T>(
  question: string,
  options: readonly Option<T>[],
  opts: PromptOpts & { initial?: number; fallback?: T },
): Promise<T | null> {
  const { term } = opts;
  if (!term.isTTY) return nonInteractive(term, question, opts.fallback ?? null);
  const { style: st, glyphs: g } = term;

  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return null;
  let cursor = enabled.includes(opts.initial ?? 0) ? (opts.initial ?? 0) : enabled[0];

  const move = (dir: 1 | -1): void => {
    const pos = enabled.indexOf(cursor);
    cursor = enabled[(pos + dir + enabled.length) % enabled.length];
  };

  const width = () => term.columns() - 1;
  const view = (): string[] => {
    const lines = [st.bold(question), ''];
    // Viewport for long lists (project pickers can exceed the screen).
    const maxRows = Math.max(3, term.rows() - 5);
    let start = 0;
    if (options.length > maxRows) {
      start = Math.min(Math.max(0, cursor - Math.floor(maxRows / 2)), options.length - maxRows);
    }
    const slice = options.slice(start, start + maxRows);
    if (start > 0) lines.push(st.dim(`  ${g.more} ${start} more`));
    slice.forEach((o, idx) => {
      const i = start + idx;
      const sel = i === cursor;
      const pointer = sel ? st.accent(g.cursor) + ' ' : '  ';
      const label = o.disabled ? st.dim(o.label) : sel ? st.accent(o.label) : o.label;
      const hint = o.hint ? st.dim(o.hint) : '';
      lines.push(pointer + twoColumn(label, hint, width() - 2));
    });
    const below = options.length - start - slice.length;
    if (below > 0) lines.push(st.dim(`  ${g.more} ${below} more`));
    lines.push('', st.dim(`  ↑↓ move ${g.dot} 1-9 jump ${g.dot} enter select ${g.dot} esc cancel`));
    return lines;
  };

  return drive<T | null>(
    term,
    view,
    (k) => {
      if (isCancel(k)) return { done: true, value: null };
      if (isSubmit(k)) return { done: true, value: options[cursor].value };
      if (isUp(k)) {
        move(-1);
        return { done: false };
      }
      if (isDown(k)) {
        move(1);
        return { done: false };
      }
      if (k.char >= '1' && k.char <= '9') {
        const i = Number(k.char) - 1;
        if (i < options.length && !options[i].disabled) {
          cursor = i;
          return { done: true, value: options[i].value };
        }
      }
      return { done: false };
    },
    (value) => {
      const picked = options[cursor];
      return value === null
        ? [st.dim(`${question}  ${g.dot} cancelled`)]
        : [`${st.ok(g.check)} ${question}  ${st.dim(picked.label)}`];
    },
  );
}

export async function text(
  question: string,
  opts: PromptOpts & { placeholder?: string; default?: string; validate?: (v: string) => string | undefined; fallback?: string },
): Promise<string | null> {
  const { term } = opts;
  if (!term.isTTY) return nonInteractive(term, question, opts.fallback ?? null);
  const { style: st, glyphs: g } = term;

  let value = '';
  let cursor = 0;
  let error: string | undefined;

  const view = (): string[] => {
    // The frame owns cursor position, so the caret is drawn with inverse
    // video rather than a real cursor move.
    let body: string;
    if (!value && opts.placeholder) {
      body = st.inverse(opts.placeholder.slice(0, 1) || ' ') + st.dim(opts.placeholder.slice(1));
    } else {
      const at = value[cursor] ?? ' ';
      body = value.slice(0, cursor) + st.inverse(at) + value.slice(cursor + 1);
    }
    const lines = [st.bold(question), `  ${body}`];
    if (error) lines.push(`  ${st.err(error)}`);
    lines.push('', st.dim(`  enter submit ${g.dot} esc cancel${opts.default !== undefined ? ` ${g.dot} empty ${g.arrow} ${opts.default || '""'}` : ''}`));
    return lines;
  };

  return drive<string | null>(
    term,
    view,
    (k) => {
      error = undefined;
      if (isCancel(k)) return { done: true, value: null };
      if (isSubmit(k)) {
        const out = value || opts.default || '';
        const invalid = opts.validate?.(out);
        if (invalid) {
          error = invalid;
          return { done: false };
        }
        return { done: true, value: out };
      }
      switch (k.name) {
        case 'backspace':
          if (cursor > 0) {
            value = value.slice(0, cursor - 1) + value.slice(cursor);
            cursor--;
          }
          return { done: false };
        case 'delete':
          value = value.slice(0, cursor) + value.slice(cursor + 1);
          return { done: false };
        case 'left':
          cursor = Math.max(0, cursor - 1);
          return { done: false };
        case 'right':
          cursor = Math.min(value.length, cursor + 1);
          return { done: false };
        case 'home':
          cursor = 0;
          return { done: false };
        case 'end':
          cursor = value.length;
          return { done: false };
      }
      if (k.ctrl && k.name === 'a') cursor = 0;
      else if (k.ctrl && k.name === 'e') cursor = value.length;
      else if (k.ctrl && k.name === 'u') {
        value = value.slice(cursor);
        cursor = 0;
      } else if (k.ctrl && k.name === 'w') {
        const head = value.slice(0, cursor).replace(/\S+\s*$/, '');
        value = head + value.slice(cursor);
        cursor = head.length;
      } else if (k.char) {
        value = value.slice(0, cursor) + k.char + value.slice(cursor);
        cursor += k.char.length;
      }
      return { done: false };
    },
    (v) =>
      v === null
        ? [st.dim(`${question}  ${g.dot} cancelled`)]
        : [`${st.ok(g.check)} ${question}  ${st.dim(truncate(v, 40))}`],
  );
}

export async function confirm(
  question: string,
  opts: PromptOpts & { initial?: boolean; fallback?: boolean },
): Promise<boolean | null> {
  const { term } = opts;
  if (!term.isTTY) return nonInteractive(term, question, opts.fallback ?? null);
  const { style: st, glyphs: g } = term;
  let value = opts.initial ?? true;

  const view = (): string[] => [
    st.bold(question),
    `  ${value ? st.accent(`${g.cursor} yes`) : '  yes'}    ${value ? '  no' : st.accent(`${g.cursor} no`)}`,
    '',
    st.dim(`  ←→ flip ${g.dot} enter confirm ${g.dot} y/n ${g.dot} esc cancel`),
  ];

  return drive<boolean | null>(
    term,
    view,
    (k) => {
      if (isCancel(k)) return { done: true, value: null };
      if (isSubmit(k)) return { done: true, value };
      if (k.char === 'y' || k.char === 'Y') return { done: true, value: true };
      if (k.char === 'n' || k.char === 'N') return { done: true, value: false };
      if (k.name === 'left' || k.name === 'right' || k.name === 'tab' || isUp(k) || isDown(k)) value = !value;
      return { done: false };
    },
    (v) =>
      v === null
        ? [st.dim(`${question}  ${g.dot} cancelled`)]
        : [`${st.ok(g.check)} ${question}  ${st.dim(v ? 'yes' : 'no')}`],
  );
}
