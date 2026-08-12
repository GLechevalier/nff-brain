// The review checklist: sectioned, scrolling, toggleable list of extracted
// memories. The interesting logic (section skipping, viewport math) lives in
// a pure reducer so vitest can drive it without a TTY.

import { isCancel, isDown, isSubmit, isToggle, isUp, type Key } from './keys.js';
import { createFrame } from './frame.js';
import { padStartTo, truncate, wrap } from './width.js';
import type { Term } from './term.js';
import type { PromptOpts } from './prompts.js';

export interface ChecklistItem {
  id: string;
  title: string;
  confidence?: number;
  body?: string;
  provenance?: string;
  checked: boolean;
  locked?: boolean;
}

export interface ChecklistSection {
  title: string;
  hint?: string;
  items: ChecklistItem[];
}

export interface ChecklistResult {
  checked: string[];
  unchecked: string[];
}

export type Row =
  | { kind: 'section'; sectionIndex: number }
  | { kind: 'item'; sectionIndex: number; itemIndex: number };

export interface Viewport {
  width: number;
  height: number;
}

export interface ChecklistState {
  question: string;
  sections: ChecklistSection[];
  rows: Row[];
  /** Indices into `rows` — section headers absent by construction. */
  selectable: number[];
  /** Index into `selectable`. */
  cursor: number;
  /** Index into `rows`, whole rows only. */
  scrollTop: number;
  width: number;
  height: number;
  /** Row heights cached per width; invalidated on resize. */
  heights: number[];
}

function buildRows(sections: ChecklistSection[]): { rows: Row[]; selectable: number[] } {
  const rows: Row[] = [];
  const selectable: number[] = [];
  sections.forEach((sec, sectionIndex) => {
    if (!sec.items.length) return;
    rows.push({ kind: 'section', sectionIndex });
    sec.items.forEach((_item, itemIndex) => {
      selectable.push(rows.length);
      rows.push({ kind: 'item', sectionIndex, itemIndex });
    });
  });
  return { rows, selectable };
}

export function measureRow(s: ChecklistState, row: Row, width: number): number {
  if (row.kind === 'section') return 2; // blank + header
  const item = s.sections[row.sectionIndex].items[row.itemIndex];
  let h = 1; // title line
  if (item.body) h += Math.min(3, wrap(item.body, Math.max(10, width - 8)).length);
  if (item.provenance) h += 1;
  return h;
}

function recomputeHeights(s: ChecklistState): void {
  s.heights = s.rows.map((r) => measureRow(s, r, s.width));
}

export function initChecklist(question: string, sections: ChecklistSection[], vp: Viewport): ChecklistState {
  const { rows, selectable } = buildRows(sections);
  const s: ChecklistState = {
    question,
    sections,
    rows,
    selectable,
    cursor: 0,
    scrollTop: 0,
    width: vp.width,
    height: vp.height,
    heights: [],
  };
  recomputeHeights(s);
  return ensureVisible(s);
}

/** Lines the list body may occupy: total minus header(2) + footer(2). */
function viewportLines(s: ChecklistState): number {
  return Math.max(3, s.height - 4);
}

/** Rows [scrollTop, end) that fit; clamps a row taller than the viewport. */
function visibleRange(s: ChecklistState): { end: number; overflowTop: boolean; overflowBottom: boolean } {
  const overflowTop = s.scrollTop > 0;
  let budget = viewportLines(s);
  // Reserve indicator lines UNCONDITIONALLY when anything overflows — sizing
  // them reactively makes the fit flip on every keypress (the oscillation
  // bug called out in the design).
  const totalH = s.heights.reduce((a, b) => a + b, 0);
  const anyOverflow = totalH > budget;
  if (anyOverflow) budget -= 2; // one line up-indicator, one down-indicator
  let end = s.scrollTop;
  while (end < s.rows.length) {
    const h = s.heights[end];
    if (h > budget && end === s.scrollTop) {
      // Single row taller than the viewport: render it clamped, move on.
      end++;
      break;
    }
    if (h > budget) break;
    budget -= h;
    end++;
  }
  return { end, overflowTop, overflowBottom: end < s.rows.length };
}

export function ensureVisible(s: ChecklistState): ChecklistState {
  if (!s.selectable.length) return s;
  const target = s.selectable[s.cursor];
  // Keep the section header above the cursor visible when it's adjacent.
  const anchor = target > 0 && s.rows[target - 1].kind === 'section' ? target - 1 : target;
  if (anchor < s.scrollTop) {
    s.scrollTop = anchor;
    return s;
  }
  // Guarded walk: at most rows.length iterations, never an unbounded loop.
  for (let guard = 0; guard < s.rows.length; guard++) {
    const { end } = visibleRange(s);
    if (target < end) return s;
    if (s.scrollTop >= target) return s; // row taller than viewport — clamped
    s.scrollTop++;
  }
  return s;
}

function currentItem(s: ChecklistState): ChecklistItem | undefined {
  const row = s.rows[s.selectable[s.cursor]];
  return row?.kind === 'item' ? s.sections[row.sectionIndex].items[row.itemIndex] : undefined;
}

export type ChecklistOutcome =
  | { state: ChecklistState }
  | { state: ChecklistState; done: { result: ChecklistResult } }
  | { state: ChecklistState; done: { cancelled: true } };

function result(s: ChecklistState): ChecklistResult {
  const checked: string[] = [];
  const unchecked: string[] = [];
  for (const sec of s.sections) for (const i of sec.items) (i.checked ? checked : unchecked).push(i.id);
  return { checked, unchecked };
}

export function reduceChecklist(s: ChecklistState, k: Key): ChecklistOutcome {
  if (isCancel(k)) return { state: s, done: { cancelled: true } };
  if (isSubmit(k)) return { state: s, done: { result: result(s) } };

  const last = s.selectable.length - 1;
  if (isUp(k)) s.cursor = Math.max(0, s.cursor - 1);
  else if (isDown(k)) s.cursor = Math.min(last, s.cursor + 1);
  else if (k.name === 'home' || k.char === 'g') s.cursor = 0;
  else if (k.name === 'end' || k.char === 'G') s.cursor = last;
  else if (k.name === 'pageup' || k.name === 'pagedown') {
    const step = Math.max(1, Math.floor(viewportLines(s) / 3));
    s.cursor = k.name === 'pageup' ? Math.max(0, s.cursor - step) : Math.min(last, s.cursor + step);
  } else if (isToggle(k)) {
    const item = currentItem(s);
    if (item && !item.locked) item.checked = !item.checked;
  } else if (k.char === 'a' || k.char === 'n') {
    const on = k.char === 'a';
    for (const sec of s.sections) for (const i of sec.items) if (!i.locked) i.checked = on;
  } else if (k.char === 's') {
    const row = s.rows[s.selectable[s.cursor]];
    if (row?.kind === 'item') {
      const sec = s.sections[row.sectionIndex];
      const on = sec.items.some((i) => !i.locked && !i.checked);
      for (const i of sec.items) if (!i.locked) i.checked = on;
    }
  }
  return { state: ensureVisible(s) };
}

export interface ChecklistView {
  header: (s: ChecklistState) => string[];
}

export function viewChecklist(s: ChecklistState, term?: Term): string[] {
  const st = term?.style;
  const g = term?.glyphs;
  const dim = (x: string) => st?.dim(x) ?? x;
  const bold = (x: string) => st?.bold(x) ?? x;
  const accent = (x: string) => st?.accent(x) ?? x;
  const cursorGlyph = g?.cursor ?? '>';
  const dot = g?.dot ?? '·';
  const boxOn = g?.boxOn ?? '[x]';
  const boxOff = g?.boxOff ?? '[ ]';

  const total = s.sections.reduce((a, sec) => a + sec.items.length, 0);
  const nChecked = s.sections.reduce((a, sec) => a + sec.items.filter((i) => i.checked).length, 0);

  const lines: string[] = [
    bold(s.question) + dim(`   ${nChecked} of ${total} selected`),
    '',
  ];

  const { end, overflowTop, overflowBottom } = visibleRange(s);
  const totalH = s.heights.reduce((a, b) => a + b, 0);
  const anyOverflow = totalH > viewportLines(s);
  if (anyOverflow) lines.push(overflowTop ? dim(`  ${g?.more ?? '...'} ${s.scrollTop} rows above`) : '');

  const bodyWidth = Math.max(10, s.width - 8);
  const cursorRow = s.selectable[s.cursor];
  let budget = viewportLines(s) - (anyOverflow ? 2 : 0);

  for (let r = s.scrollTop; r < end; r++) {
    const row = s.rows[r];
    if (row.kind === 'section') {
      const sec = s.sections[row.sectionIndex];
      if (budget < 2) break;
      lines.push('', accent(bold(`${sec.title} (${sec.items.length})`)) + (sec.hint ? dim(`  ${sec.hint}`) : ''));
      budget -= 2;
      continue;
    }
    const item = s.sections[row.sectionIndex].items[row.itemIndex];
    const sel = r === cursorRow;
    const pointer = sel ? accent(cursorGlyph) + ' ' : '  ';
    const box = item.checked ? (sel ? accent(boxOn) : boxOn) : dim(boxOff);
    const conf = item.confidence !== undefined ? dim(padStartTo(item.confidence.toFixed(2), 6)) : '';
    const titleWidth = Math.max(10, s.width - 14);
    const title = sel ? bold(truncate(item.title, titleWidth)) : truncate(item.title, titleWidth);
    if (budget < 1) break;
    lines.push(`${pointer}${box} ${title}${conf}`);
    budget -= 1;
    if (item.body) {
      for (const l of wrap(item.body, bodyWidth).slice(0, 3)) {
        if (budget < 1) break;
        lines.push(dim(`      ${l}`));
        budget -= 1;
      }
    }
    if (item.provenance && budget >= 1) {
      lines.push(dim(`      ${g?.branch ?? '\\'} ${truncate(item.provenance, bodyWidth)}`));
      budget -= 1;
    }
  }

  if (anyOverflow) lines.push(overflowBottom ? dim(`  ${g?.more ?? '...'} more below`) : '');

  lines.push('', dim(`  ↑↓ move ${dot} space toggle ${dot} a all ${dot} n none ${dot} s section ${dot} enter apply ${dot} esc cancel`));
  return lines;
}

export async function checklist(
  question: string,
  sections: readonly ChecklistSection[],
  opts: PromptOpts,
): Promise<ChecklistResult | null> {
  const { term } = opts;
  if (!term.isTTY) {
    if (opts.fallback !== undefined) return opts.fallback as ChecklistResult;
    throw new Error(`"${question}" needs an interactive terminal — edit the preview file and run \`import --apply\` instead`);
  }

  let state = initChecklist(question, sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) })), {
    width: term.columns(),
    height: term.rows(),
  });

  const frame = createFrame(term);
  const offResize = term.onResize(() => {
    state.width = term.columns();
    state.height = term.rows();
    state.heights = state.rows.map((r) => measureRow(state, r, state.width));
    ensureVisible(state);
    frame.render(viewChecklist(state, term));
  });

  try {
    return await new Promise<ChecklistResult | null>((resolve) => {
      const off = term.onKey((k) => {
        const outcome = reduceChecklist(state, k);
        state = outcome.state;
        if ('done' in outcome) {
          off();
          if ('cancelled' in outcome.done) {
            frame.close();
            resolve(null);
          } else {
            const n = outcome.done.result.checked.length;
            frame.close([`${term.style.ok(term.glyphs.check)} ${question}  ${term.style.dim(`${n} selected`)}`]);
            resolve(outcome.done.result);
          }
          return;
        }
        frame.render(viewChecklist(state, term));
      });
      frame.render(viewChecklist(state, term));
    });
  } finally {
    offResize();
  }
}
