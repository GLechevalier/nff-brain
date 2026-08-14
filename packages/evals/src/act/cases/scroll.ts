// Scroll-family conformance cases (layer A).

import { defineConformance } from '../actScenario.js';
import { fail, pass, rectCenter, rectOf, settledState, sleep } from './helpers.js';

const PAGE = 'scroll.html';

export const scrollCases = [
  defineConformance({
    id: 'primitives.scroll-wheel-page.L1',
    family: 'scroll',
    title: 'Wheel over the page body scrolls the page',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      // A point in the spacer region, clear of both nested containers.
      const p = { x: Math.round(snap.viewport.w / 2), y: Math.round(snap.viewport.h * 0.85) };
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.wheel', target: p, dx: 0, dy: 900 });
      await sleep(800); // eased wheel glide + settle
      const s = await settledState(ctx, PAGE);
      const y = Number(s.pageY);
      return y > 300 ? pass(`page scrolled to y=${y}`) : fail(`pageY=${y} after dy=900`);
    },
  }),

  defineConformance({
    id: 'primitives.scroll-wheel-nested.L1',
    family: 'scroll',
    title: 'Wheel over a nested container scrolls the container, not the page',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const p = rectCenter(await rectOf(ctx, PAGE, 'nested'));
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.wheel', target: p, dx: 0, dy: 600 });
      await sleep(800);
      const s = await settledState(ctx, PAGE);
      const nested = Number(s.nestedTop);
      const page = Number(s.pageY);
      if (nested < 200) return fail(`nested container only reached ${nested}px`);
      if (page > 40) return fail(`the PAGE scrolled too (y=${page}) — wheel leaked out of the container`);
      return pass(`nested scrolled to ${nested}px, page held at ${page}px`);
    },
  }),

  defineConformance({
    id: 'primitives.scroll-horizontal-dx.L1',
    family: 'scroll',
    title: 'Wheel with a horizontal delta scrolls a horizontal strip',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const p = rectCenter(await rectOf(ctx, PAGE, 'hstrip'));
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.wheel', target: p, dx: 500, dy: 0 });
      await sleep(800);
      const s = await settledState(ctx, PAGE);
      const left = Number(s.hstripLeft);
      return left > 150 ? pass(`strip scrolled to left=${left}`) : fail(`hstripLeft=${left} after dx=500`);
    },
  }),

  defineConformance({
    id: 'primitives.scroll-shift-horizontal.L1',
    family: 'scroll',
    title: 'Shift+vertical-wheel maps to horizontal scrolling',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const p = rectCenter(await rectOf(ctx, PAGE, 'hstrip'));
      const before = Number((await settledState(ctx, PAGE)).hstripLeft);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.wheel', target: p, dx: 0, dy: 500, modifiers: { shift: true } });
      await sleep(800);
      const s = await settledState(ctx, PAGE);
      const left = Number(s.hstripLeft);
      return left > before + 100
        ? pass(`shift+wheel moved the strip ${before}→${left}`)
        : fail(`hstripLeft ${before}→${left} — the shift remap did not engage for synthesized wheels`);
    },
  }),

  defineConformance({
    id: 'primitives.scroll-ctrl-zoom.L1',
    family: 'scroll',
    title: 'Ctrl+wheel zooms the page',
    requires: ['ACT-harness', 'ACT-engine'],
    knownGap:
      'browser-level zoom is a browser-chrome gesture — a renderer-dispatched mouseWheel with the ctrl bit never engages it (page.zoom covers the intent, see content-page-zoom)',
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const p = { x: Math.round(snap.viewport.w / 2), y: Math.round(snap.viewport.h / 2) };
      try {
        await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.wheel', target: p, dx: 0, dy: -600, modifiers: { ctrl: true } });
        await sleep(900);
        const zoom = await ctx.driver.getZoom(ctx.tabId);
        return Math.abs(zoom - 1) > 0.05
          ? pass(`ctrl+wheel changed zoom to ${zoom.toFixed(2)}`)
          : fail(`zoom still ${zoom.toFixed(2)} — the ctrl-zoom gesture did not engage`);
      } finally {
        await ctx.driver.verb(ctx.tabId, { kind: 'page.zoom', factor: 1 }).catch(() => undefined);
      }
    },
  }),

  defineConformance({
    id: 'primitives.scroll-intoview.L1',
    family: 'scroll',
    title: 'scroll.intoView reaches a below-fold target, which then clicks',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const t = ctx.driver.findRef(snap, 'deep target button', 'button');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'scroll.intoView', ref: t.ref, snapshotId: t.snapshotId });
      await sleep(800); // smooth scroll settle
      const fresh = await ctx.driver.read(ctx.tabId);
      const t2 = ctx.driver.findRef(fresh, 'deep target button', 'button');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'pointer.click', target: t2, button: 'left', clickCount: 1 });
      const s = await settledState(ctx, PAGE);
      if (Number(s.deepClicked) < 1) return fail(`scrolled to y=${fresh.viewport.scrollY} but the click missed`);
      return fresh.viewport.scrollY > 1200
        ? pass(`intoView landed at y=${fresh.viewport.scrollY}, click connected`)
        : fail(`click connected but scrollY=${fresh.viewport.scrollY} looks wrong`);
    },
  }),

  defineConformance({
    id: 'primitives.scroll-keys.L1',
    family: 'scroll',
    title: 'PageDown / End / Home scroll the page from keyboard',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      // Click empty body space to give the page focus without hitting a widget.
      await ctx.driver.mustVerb(ctx.tabId, {
        kind: 'pointer.click',
        target: { x: Math.round(snap.viewport.w / 2), y: Math.round(snap.viewport.h * 0.85) },
        button: 'left',
        clickCount: 1,
      });
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.press', key: 'PageDown', count: 3 });
      await sleep(600);
      const afterPgDn = Number((await settledState(ctx, PAGE)).pageY);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.press', key: 'End' });
      await sleep(600);
      const afterEnd = Number((await settledState(ctx, PAGE)).pageY);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.press', key: 'Home' });
      await sleep(600);
      const afterHome = Number((await settledState(ctx, PAGE)).pageY);
      if (afterPgDn < 300) return fail(`PageDown×3 only reached y=${afterPgDn}`);
      if (afterEnd <= afterPgDn) return fail(`End did not go further (${afterPgDn}→${afterEnd})`);
      if (afterHome > 40) return fail(`Home left the page at y=${afterHome}`);
      return pass(`PageDown→${afterPgDn}, End→${afterEnd}, Home→${afterHome}`);
    },
  }),
];
