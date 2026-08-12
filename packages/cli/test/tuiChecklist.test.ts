import { describe, expect, it } from 'vitest';
import {
  initChecklist,
  reduceChecklist,
  viewChecklist,
  type ChecklistSection,
  type ChecklistState,
} from '../src/tui/checklist.js';
import type { Key } from '../src/tui/keys.js';

const K = (name: string, extra: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  sequence: '',
  char: '',
  ...extra,
});
const CHAR = (c: string): Key => K('', { char: c });

function sections(spec: Array<[string, number]>, body = ''): ChecklistSection[] {
  return spec.map(([title, n], si) => ({
    title,
    items: Array.from({ length: n }, (_, i) => ({
      id: `s${si}-i${i}`,
      title: `Item ${si}.${i}`,
      confidence: 0.8,
      body,
      checked: i % 2 === 0,
    })),
  }));
}

function currentId(s: ChecklistState): string {
  const row = s.rows[s.selectable[s.cursor]];
  if (row.kind !== 'item') throw new Error('cursor on a non-item row');
  return s.sections[row.sectionIndex].items[row.itemIndex].id;
}

describe('checklist reducer', () => {
  it('starts on the first item, not the section header', () => {
    const s = initChecklist('q', sections([['A', 2], ['B', 2]]), { width: 80, height: 24 });
    expect(currentId(s)).toBe('s0-i0');
  });

  it('skips section headers when moving down across a boundary', () => {
    let s = initChecklist('q', sections([['A', 2], ['B', 2]]), { width: 80, height: 24 });
    s = reduceChecklist(s, K('down')).state; // s0-i1
    s = reduceChecklist(s, K('down')).state; // must land on s1-i0, not the header
    expect(currentId(s)).toBe('s1-i0');
  });

  it('space toggles, a/n set all, s toggles the current section', () => {
    let s = initChecklist('q', sections([['A', 2], ['B', 2]]), { width: 80, height: 24 });
    expect(s.sections[0].items[0].checked).toBe(true);
    s = reduceChecklist(s, K('space')).state;
    expect(s.sections[0].items[0].checked).toBe(false);
    s = reduceChecklist(s, CHAR('a')).state;
    expect(s.sections.flatMap((x) => x.items).every((i) => i.checked)).toBe(true);
    s = reduceChecklist(s, CHAR('n')).state;
    expect(s.sections.flatMap((x) => x.items).every((i) => !i.checked)).toBe(true);
    s = reduceChecklist(s, CHAR('s')).state; // section A back on
    expect(s.sections[0].items.every((i) => i.checked)).toBe(true);
    expect(s.sections[1].items.every((i) => !i.checked)).toBe(true);
  });

  it('locked items resist space and a/n', () => {
    const secs = sections([['A', 1]]);
    secs[0].items[0].locked = true;
    secs[0].items[0].checked = false;
    let s = initChecklist('q', secs, { width: 80, height: 24 });
    s = reduceChecklist(s, K('space')).state;
    s = reduceChecklist(s, CHAR('a')).state;
    expect(s.sections[0].items[0].checked).toBe(false);
  });

  it('enter returns the checked/unchecked split, esc cancels', () => {
    const s = initChecklist('q', sections([['A', 3]]), { width: 80, height: 24 });
    const done = reduceChecklist(s, K('return'));
    expect('done' in done && 'result' in done.done! && done.done.result.checked).toEqual(['s0-i0', 's0-i2']);
    const esc = reduceChecklist(s, K('escape'));
    expect('done' in esc && esc.done).toEqual({ cancelled: true });
  });

  it('the merged esc+key event still cancels (the escape-window quirk)', () => {
    const s = initChecklist('q', sections([['A', 1]]), { width: 80, height: 24 });
    const merged = reduceChecklist(s, K('', { meta: true, sequence: '\x1b\x03' }));
    expect('done' in merged && merged.done).toEqual({ cancelled: true });
  });

  it('never renders more lines than the viewport, whatever the content', () => {
    let s = initChecklist('q', sections([['A', 20], ['B', 20]], 'a body line that wraps a bit'), {
      width: 60,
      height: 12,
    });
    for (let i = 0; i < 45; i++) {
      expect(viewChecklist(s).length).toBeLessThanOrEqual(12);
      s = reduceChecklist(s, K('down')).state;
    }
    // We walked to the end — the last item must be reachable and visible.
    expect(currentId(s)).toBe('s1-i19');
  });

  it('terminates when a single item is taller than the whole viewport', () => {
    const tall = sections([['A', 3]], 'word '.repeat(120)); // wraps to many lines
    let s = initChecklist('q', tall, { width: 24, height: 6 });
    for (let i = 0; i < 6; i++) s = reduceChecklist(s, K('down')).state; // must not hang
    expect(viewChecklist(s).length).toBeLessThanOrEqual(8);
  });

  it('scrolling down then home returns to the top with the header visible', () => {
    let s = initChecklist('q', sections([['A', 30]]), { width: 80, height: 10 });
    for (let i = 0; i < 25; i++) s = reduceChecklist(s, K('down')).state;
    expect(s.scrollTop).toBeGreaterThan(0);
    s = reduceChecklist(s, K('home')).state;
    expect(currentId(s)).toBe('s0-i0');
    expect(s.scrollTop).toBe(0);
  });
});
