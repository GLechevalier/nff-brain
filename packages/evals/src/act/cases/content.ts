// Page-content conformance cases (layer A).

import { defineConformance } from '../actScenario.js';
import { clickAt, eventsOf, fail, pass, press, rectCenter, rectOf, sleep } from './helpers.js';

const PAGE = 'content.html';

export const contentCases = [
  defineConformance({
    id: 'primitives.content-page-zoom.L1',
    family: 'content',
    title: 'page.zoom changes browser zoom and restores it',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      try {
        await ctx.driver.mustVerb(ctx.tabId, { kind: 'page.zoom', factor: 1.5 });
        await sleep(400);
        const zoomed = await ctx.driver.getZoom(ctx.tabId);
        if (Math.abs(zoomed - 1.5) > 0.05) return fail(`zoom=${zoomed.toFixed(2)} after page.zoom 1.5`);
        await ctx.driver.mustVerb(ctx.tabId, { kind: 'page.zoom', factor: 1 });
        await sleep(400);
        const restored = await ctx.driver.getZoom(ctx.tabId);
        return Math.abs(restored - 1) < 0.05 ? pass('zoomed to 1.5 and back') : fail(`restore left zoom=${restored.toFixed(2)}`);
      } finally {
        await ctx.driver.verb(ctx.tabId, { kind: 'page.zoom', factor: 1 }).catch(() => undefined);
      }
    },
  }),

  defineConformance({
    id: 'primitives.content-read-text.L1',
    family: 'content',
    title: "page.read mode:'text' extracts the article text",
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId, 'text');
      const text = snap.text ?? '';
      return text.includes('XYLOPHONE-EIGHTY-ONE')
        ? pass('codeword present in the text extraction')
        : fail(`codeword missing — got ${text.length} chars`);
    },
  }),

  defineConformance({
    id: 'primitives.content-select-copy.L1',
    family: 'content',
    title: 'Select a paragraph and copy it (clipboard)',
    requires: ['ACT-clipboard'],
    page: PAGE,
    async run(ctx) {
      await clickAt(ctx, rectCenter(await rectOf(ctx, PAGE, 'para-1')), { clickCount: 3 });
      await press(ctx, 'c', { modifiers: { ctrl: true } });
      await sleep(500);
      return eventsOf(ctx, PAGE, 'copy').length >= 1 ? pass('copy event fired on the selection') : fail('no copy event');
    },
  }),

  defineConformance({
    id: 'primitives.content-find-verb.L1',
    family: 'content',
    title: 'page.find locates text on the page',
    requires: ['ACT-observe-extras'],
    page: PAGE,
    async run(ctx) {
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'page.find', query: 'XYLOPHONE-EIGHTY-ONE' });
      if (!r.ok) return fail(`page.find refused: ${r.resultText}`);
      return /found|match|1/i.test(r.resultText) ? pass(r.resultText) : fail(`unexpected find result: ${r.resultText}`);
    },
  }),

  defineConformance({
    id: 'primitives.content-screenshot-verb.L1',
    family: 'content',
    title: 'page.screenshot captures the viewport',
    requires: ['ACT-observe-extras'],
    page: PAGE,
    async run(ctx) {
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'page.screenshot' });
      return r.ok ? pass(r.resultText) : fail(`page.screenshot refused: ${r.resultText}`);
    },
  }),
];
