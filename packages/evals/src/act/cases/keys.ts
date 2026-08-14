// Keyboard-family conformance cases (layer A).

import { defineConformance } from '../actScenario.js';
import { clickByName, eventsOf, fail, focusByName, pass, press, settledState, sleep } from './helpers.js';

const PAGE = 'keys.html';

export const keysCases = [
  defineConformance({
    id: 'primitives.keys-type-insert.L1',
    family: 'keys',
    title: "key.type (insert mode) fills a focused field",
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'type here');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: 'Hello, bench!' });
      const s = await settledState(ctx, PAGE);
      return s.typeValue === 'Hello, bench!'
        ? pass('field holds the typed text')
        : fail(`field holds ${JSON.stringify(s.typeValue)}`);
    },
  }),

  defineConformance({
    id: 'primitives.keys-type-perkey.L1',
    family: 'keys',
    title: "key.type mode:'keys' emits per-character key events",
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const TEXT = 'ab1!';
      await focusByName(ctx, 'type here');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: TEXT, mode: 'keys' });
      const s = await settledState(ctx, PAGE);
      const downs = eventsOf(ctx, PAGE, 'keydown', 'type-box');
      if (s.typeValue !== TEXT) return fail(`value=${JSON.stringify(s.typeValue)}, wanted ${JSON.stringify(TEXT)}`);
      if (downs.length < TEXT.length) return fail(`only ${downs.length} keydown events for ${TEXT.length} chars`);
      const blankCodes = downs.filter((e) => e.code === '').length;
      return pass(`value ok, ${downs.length} keydowns (${blankCodes} with empty code — punctuation gap)`);
    },
  }),

  defineConformance({
    id: 'primitives.keys-tab-traversal.L1',
    family: 'keys',
    title: 'Tab moves focus forward through the tab order',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'tab 1');
      await press(ctx, 'Tab', { count: 3 });
      const s = await settledState(ctx, PAGE);
      const focusIns = eventsOf(ctx, PAGE, 'focusin').map((e) => e.target);
      return s.focused === 'tab-4'
        ? pass(`focus walked ${focusIns.join(' → ')}`)
        : fail(`focus ended on ${String(s.focused)} (path: ${focusIns.join(' → ')})`);
    },
  }),

  defineConformance({
    id: 'primitives.keys-shift-tab.L1',
    family: 'keys',
    title: 'Shift+Tab moves focus backward',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'tab 4');
      await press(ctx, 'Tab', { modifiers: { shift: true } });
      const s = await settledState(ctx, PAGE);
      return s.focused === 'tab-3'
        ? pass('Shift+Tab landed on tab-3')
        : fail(`focus on ${String(s.focused)} — the shift bitmask alone may not reverse Tab`);
    },
  }),

  defineConformance({
    id: 'primitives.keys-enter-submit.L1',
    family: 'keys',
    title: 'Enter in a form field submits the form',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'press Enter here');
      await press(ctx, 'Enter');
      const s = await settledState(ctx, PAGE);
      return Number(s.submits) >= 1 ? pass('form submitted') : fail('no submit event');
    },
  }),

  defineConformance({
    id: 'primitives.keys-space-checkbox.L1',
    family: 'keys',
    title: 'Space toggles a focused checkbox',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'toggle me with Space');
      await press(ctx, 'Space');
      const s = await settledState(ctx, PAGE);
      return s.spaceChecked === true ? pass('checkbox checked via Space') : fail('checkbox still unchecked');
    },
  }),

  defineConformance({
    id: 'primitives.keys-escape-dialog.L1',
    family: 'keys',
    title: 'Escape dismisses an open <dialog>',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'open dialog');
      await sleep(300);
      const open = await settledState(ctx, PAGE);
      if (open.dlgOpen !== true) return fail('dialog never opened');
      await press(ctx, 'Escape');
      const s = await settledState(ctx, PAGE);
      return s.dlgOpen === false ? pass('Escape closed the dialog') : fail('dialog still open after Escape');
    },
  }),

  defineConformance({
    id: 'primitives.keys-clipboard-shortcuts.L1',
    family: 'keys',
    title: 'Ctrl+A / Ctrl+C / Ctrl+V round-trip through the clipboard',
    requires: ['ACT-clipboard'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'type here');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: 'copy me' });
      await press(ctx, 'a', { modifiers: { ctrl: true } });
      await press(ctx, 'c', { modifiers: { ctrl: true } });
      await press(ctx, 'End');
      await press(ctx, 'v', { modifiers: { ctrl: true } });
      const s = await settledState(ctx, PAGE);
      const copies = eventsOf(ctx, PAGE, 'copy');
      const pastes = eventsOf(ctx, PAGE, 'paste');
      return copies.length >= 1 && pastes.length >= 1 && s.typeValue === 'copy mecopy me'
        ? pass('copy + paste events fired, value doubled')
        : fail(`copy=${copies.length} paste=${pastes.length} value=${JSON.stringify(s.typeValue)}`);
    },
  }),
];
