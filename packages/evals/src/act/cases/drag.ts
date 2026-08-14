// Drag-family conformance cases (layer A).

import { defineConformance, type BenchCtx } from '../actScenario.js';
import { fail, pass, rectCenter, rectOf, settledState, sleep } from './helpers.js';

const PAGE = 'drag.html';

async function drag(ctx: BenchCtx, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  await ctx.driver.mustVerb(ctx.tabId, { kind: 'pointer.drag', from, to, steps });
}

export const dragCases = [
  defineConformance({
    id: 'primitives.drag-slider.L1',
    family: 'drag',
    title: 'Drag a custom slider knob to ~75%',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const strip = await rectOf(ctx, PAGE, 'slider-strip');
      const knob = rectCenter(await rectOf(ctx, PAGE, 'slider-knob'));
      await drag(ctx, knob, { x: Math.round(strip.x + strip.w * 0.75), y: knob.y });
      const s = await settledState(ctx, PAGE);
      const v = Number(s.slider);
      return v >= 60 && v <= 90 ? pass(`slider landed at ${v}`) : fail(`slider=${v}, wanted ~75`);
    },
  }),

  defineConformance({
    id: 'primitives.drag-list-reorder.L1',
    family: 'drag',
    title: 'Drag-reorder a mouse-event list (alpha below charlie)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const a = rectCenter(await rectOf(ctx, PAGE, 'reorder-a'));
      const c = rectCenter(await rectOf(ctx, PAGE, 'reorder-c'));
      await drag(ctx, a, c, 16);
      const s = await settledState(ctx, PAGE);
      const order = (s.order as string[]) ?? [];
      const iA = order.indexOf('reorder-a');
      const iC = order.indexOf('reorder-c');
      return iA > iC && iA > 0
        ? pass(`order now ${order.join(' → ')}`)
        : fail(`alpha did not move below charlie: ${order.join(' → ')}`);
    },
  }),

  defineConformance({
    id: 'primitives.drag-html5-dnd.L1',
    family: 'drag',
    title: 'HTML5 draggable/drop zone accepts a mouse drag',
    requires: ['ACT-harness', 'ACT-engine'],
    // Measured 2026-08-14: Chrome DOES promote the engine's trusted CDP
    // press-move-release sequence into a native HTML5 drag session — the
    // predicted gap turned out not to exist.
    page: PAGE,
    async run(ctx) {
      const src = rectCenter(await rectOf(ctx, PAGE, 'h5-src'));
      const dst = rectCenter(await rectOf(ctx, PAGE, 'h5-drop'));
      await drag(ctx, src, dst, 16);
      const s = await settledState(ctx, PAGE);
      return s.h5Dropped === true ? pass('drop event fired') : fail('no HTML5 drop — mouse drag never became a drag session');
    },
  }),

  defineConformance({
    id: 'primitives.drag-pane-resize.L1',
    family: 'drag',
    title: 'Drag a pane divider ~80px right',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const before = Number((await settledState(ctx, PAGE)).paneLeftWidth);
      const div = rectCenter(await rectOf(ctx, PAGE, 'pane-divider'));
      await drag(ctx, div, { x: div.x + 80, y: div.y });
      const s = await settledState(ctx, PAGE);
      const w = Number(s.paneLeftWidth);
      return w >= before + 50 && w <= before + 110
        ? pass(`pane grew ${before}→${w}px`)
        : fail(`pane width ${before}→${w}px, wanted ~+80`);
    },
  }),

  defineConformance({
    id: 'primitives.drag-text-select.L1',
    family: 'drag',
    title: 'Click-drag across a sentence selects a text range',
    requires: ['ACT-harness', 'ACT-engine'],
    knownGap:
      "drag moves never carry the `buttons` bitmask (actEngine mouse() passes only `button`), so Chrome's selection controller sees button-less moves and never extends a selection",
    page: PAGE,
    async run(ctx) {
      const r = await rectOf(ctx, PAGE, 'select-para');
      const y = Math.round(r.y + r.h / 2);
      await drag(ctx, { x: r.x + 4, y }, { x: r.x + r.w - 4, y }, 20);
      await sleep(700); // selection ledger debounce
      const sel = ctx.fixtures.ledger
        .eventsFor(ctx.nonce, PAGE)
        .filter((e) => e.type === 'selection')
        .map((e) => String(e.text ?? ''));
      const hit = sel.find((t) => t.includes('all the way'));
      return hit
        ? pass(`selected "${hit.slice(0, 50)}…"`)
        : fail(`drag produced no text selection — selections seen: ${JSON.stringify(sel.slice(-3))}`);
    },
  }),

  defineConformance({
    id: 'primitives.drag-scrollbar-thumb.L1',
    family: 'drag',
    title: 'Drag the native page scrollbar thumb',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const x = snap.viewport.w - 7; // inside the native scrollbar gutter
      await drag(ctx, { x, y: 120 }, { x, y: Math.round(snap.viewport.h * 0.7) }, 20);
      const s = await settledState(ctx, PAGE);
      const after = await ctx.driver.read(ctx.tabId);
      return after.viewport.scrollY > 300
        ? pass(`thumb drag scrolled the page to y=${after.viewport.scrollY}`)
        : fail(`page still at y=${after.viewport.scrollY} (state pageY n/a: ${JSON.stringify(s.pageY ?? null)}) — synthesized mouse may not reach the native scrollbar`);
    },
  }),
];
