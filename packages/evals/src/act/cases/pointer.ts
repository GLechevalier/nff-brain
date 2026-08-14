// Pointer-family conformance cases (layer A). Every assertion reads the
// fixture ledger or the engine's own result text — never the DOM directly.

import { defineConformance } from '../actScenario.js';
import { centerOf, clickAt, clickByName, eventsOf, fail, pass, rectCenter, rectOf, settledState, sleep, waitForEvent } from './helpers.js';

const PAGE = 'pointer.html';

export const pointerCases = [
  defineConformance({
    id: 'primitives.pointer-click-left.L1',
    family: 'pointer',
    title: 'Left click lands as a trusted click event',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'left', { role: 'button' });
      const e = await waitForEvent(ctx, (ev) => ev.type === 'click' && ev.target === 'btn-left');
      if (e.isTrusted !== true) return fail(`click arrived but isTrusted=${String(e.isTrusted)}`);
      return pass('trusted left click on btn-left');
    },
  }),

  defineConformance({
    id: 'primitives.pointer-hover.L1',
    family: 'pointer',
    title: 'pointer.move triggers CSS :hover (menu appears)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const zone = rectCenter(await rectOf(ctx, PAGE, 'hover-zone'));
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'pointer.move', target: zone });
      await sleep(300);
      const after = await ctx.driver.read(ctx.tabId);
      const menuItem = after.elements.find((e) => (e.name ?? '').includes('menu item'));
      return menuItem ? pass('hover menu visible in the follow-up snapshot') : fail('menu item never appeared after pointer.move');
    },
  }),

  defineConformance({
    id: 'primitives.pointer-click-right.L1',
    family: 'pointer',
    title: 'Right click fires contextmenu',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'right (context menu suppressed)', { button: 'right' });
      await waitForEvent(ctx, (e) => e.type === 'contextmenu' && e.target === 'btn-right');
      return pass('contextmenu event on btn-right');
    },
  }),

  defineConformance({
    id: 'primitives.pointer-click-middle.L1',
    family: 'pointer',
    title: 'Middle click fires auxclick (button 1)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'middle-click me', { button: 'middle' });
      const e = await waitForEvent(ctx, (ev) => ev.type === 'auxclick' && ev.target === 'link-middle');
      if (e.button !== 1) return fail(`auxclick arrived with button=${String(e.button)}`);
      // Whether Chrome ALSO opens the link in a background tab for a
      // synthesized middle click is informational, not asserted — close it if
      // it appeared so later cases see a clean tab set.
      const tabs = await ctx.driver.listTabs();
      const opened = tabs.filter((t) => t.url.includes('nav-b.html') && t.tabId !== ctx.tabId);
      for (const t of opened) await ctx.driver.closeTab(t.tabId);
      return pass(`auxclick button 1${opened.length ? ' (and Chrome opened the link in a new tab)' : ' (no native new-tab gesture)'}`);
    },
  }),

  defineConformance({
    id: 'primitives.pointer-dblclick-detail.L1',
    family: 'pointer',
    title: 'clickCount:2 fires a dblclick handler',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'double-click (dblclick handler)', { clickCount: 2 });
      const s = await settledState(ctx, PAGE);
      return Number(s.dblHandler) >= 1 ? pass('dblclick handler fired') : fail(`dblHandler=${String(s.dblHandler)}`);
    },
  }),

  defineConformance({
    id: 'primitives.pointer-dblclick-count.L1',
    family: 'pointer',
    title: 'clickCount:2 satisfies a widget that counts two discrete clicks',
    requires: ['ACT-harness', 'ACT-engine'],
    knownGap:
      'the engine sends ONE mousePressed/Released pair with clickCount:2, so a widget counting separate click events sees a single click',
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'double-click (click counter)', { clickCount: 2 });
      const s = await settledState(ctx, PAGE);
      return Number(s.dblCountFired) >= 1
        ? pass('count-based double-click detected')
        : fail(`widget saw ${String(s.clicksOnDblCount)} click event(s), no double`);
    },
  }),

  defineConformance({
    id: 'primitives.pointer-tripleclick-select.L1',
    family: 'pointer',
    title: 'clickCount:3 selects the paragraph (line/paragraph selection)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickAt(ctx, rectCenter(await rectOf(ctx, PAGE, 'para-triple')), { clickCount: 3 });
      await sleep(700); // selection ledger events are debounced 300ms
      const sel = eventsOf(ctx, PAGE, 'selection').map((e) => String(e.text ?? ''));
      const hit = sel.find((t) => t.includes('quick brown fox'));
      return hit
        ? pass(`selection covers the paragraph ("${hit.slice(0, 40)}…")`)
        : fail(`no selection captured the sentence — saw: ${JSON.stringify(sel.slice(-3))}`);
    },
  }),

  defineConformance({
    id: 'primitives.pointer-occluded-refusal.L1',
    family: 'pointer',
    title: 'Click on a covered element is refused, then works after dismissal',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const covered = ctx.driver.findRef(snap, 'covered until the banner', 'button');
      const refusal = await ctx.driver.verb(ctx.tabId, { kind: 'pointer.click', target: covered, button: 'left', clickCount: 1 });
      if (refusal.ok) return fail('engine clicked THROUGH the overlay instead of refusing');
      if (!/covered/i.test(refusal.resultText)) return fail(`refused, but without the occlusion message: ${refusal.resultText}`);
      await clickByName(ctx, 'Accept & close');
      await clickByName(ctx, 'covered until the banner', { role: 'button' });
      const clicked = eventsOf(ctx, PAGE, 'click', 'btn-covered');
      return clicked.length >= 1
        ? pass('refused while covered; clicked after banner dismissal')
        : fail('banner dismissed but the follow-up click never landed');
    },
  }),

  defineConformance({
    id: 'primitives.pointer-ctrl-click-newtab.L1',
    family: 'pointer',
    title: 'Ctrl+click on a link opens it in a background tab',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const before = (await ctx.driver.listTabs()).length;
      await clickByName(ctx, 'ctrl-click opens me', { modifiers: { ctrl: true } });
      await sleep(1200);
      const tabs = await ctx.driver.listTabs();
      const opened = tabs.filter((t) => t.url.includes('nav-b.html'));
      for (const t of opened) await ctx.driver.closeTab(t.tabId);
      return opened.length >= 1
        ? pass(`ctrl+click opened nav-b in a new tab (${before}→${tabs.length} tabs)`)
        : fail('no new tab appeared — the ctrl modifier did not reach the click gesture');
    },
  }),

  defineConformance({
    id: 'primitives.pointer-shift-click-range.L1',
    family: 'pointer',
    title: 'Click then shift+click selects a range in a list',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickAt(ctx, rectCenter(await rectOf(ctx, PAGE, 'range-item-0')));
      await clickAt(ctx, rectCenter(await rectOf(ctx, PAGE, 'range-item-3')), { modifiers: { shift: true } });
      const s = await settledState(ctx, PAGE);
      const sel = (s.rangeSelected as string[]) ?? [];
      return sel.length === 4
        ? pass(`range selected: ${sel.join(', ')}`)
        : fail(`expected 4 selected items, got ${JSON.stringify(sel)}`);
    },
  }),

  defineConformance({
    id: 'primitives.pointer-down-up-hold.L1',
    family: 'pointer',
    title: 'pointer.down … pointer.up implements press-and-hold',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const p = await centerOf(ctx, 'press & hold', 'button');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'pointer.down', target: p, button: 'left' });
      await sleep(700);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'pointer.up', target: p, button: 'left' });
      const s = await settledState(ctx, PAGE);
      const held = Number(s.holdMs);
      return held >= 450 ? pass(`held ${held}ms`) : fail(`holdMs=${held} — press/release did not bracket the wait`);
    },
  }),
];
