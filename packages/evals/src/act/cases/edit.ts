// Caret/selection-editing conformance cases (layer A). The seed field always
// starts as "the quick brown fox" (edit.html).

import { defineConformance } from '../actScenario.js';
import { fail, focusByName, pass, press, settledState } from './helpers.js';

const PAGE = 'edit.html';

export const editCases = [
  defineConformance({
    id: 'primitives.edit-caret-navigation.L1',
    family: 'edit',
    title: 'Home / ArrowRight / Shift+End / Backspace edit a field precisely',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'edit-box');
      await press(ctx, 'End');
      await press(ctx, 'Home');
      await press(ctx, 'ArrowRight', { count: 4 }); // caret after "the "
      await press(ctx, 'End', { modifiers: { shift: true } }); // select "quick brown fox"
      await press(ctx, 'Backspace');
      const s = await settledState(ctx, PAGE);
      return s.boxValue === 'the '
        ? pass('selection-delete left exactly "the "')
        : fail(`value=${JSON.stringify(s.boxValue)} — caret/selection keys did not compose`);
    },
  }),

  defineConformance({
    id: 'primitives.edit-delete-forward.L1',
    family: 'edit',
    title: 'Home then Delete×4 removes the first word',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'edit-box');
      await press(ctx, 'Home');
      await press(ctx, 'Delete', { count: 4 });
      const s = await settledState(ctx, PAGE);
      return s.boxValue === 'quick brown fox'
        ? pass('forward-delete removed "the "')
        : fail(`value=${JSON.stringify(s.boxValue)}`);
    },
  }),

  defineConformance({
    id: 'primitives.edit-ctrl-a-replace.L1',
    family: 'edit',
    title: 'Ctrl+A select-all, then typing replaces the whole value',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'edit-box');
      await press(ctx, 'a', { modifiers: { ctrl: true } });
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: 'replaced' });
      const s = await settledState(ctx, PAGE);
      return s.boxValue === 'replaced'
        ? pass('Ctrl+A + type replaced the value')
        : fail(`value=${JSON.stringify(s.boxValue)} — select-all via modifier bitmask may not have engaged`);
    },
  }),
];
