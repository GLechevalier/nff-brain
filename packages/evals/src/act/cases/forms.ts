// Form-controls conformance cases (layer A).

import { defineConformance } from '../actScenario.js';
import { clickAt, clickByName, fail, focusByName, pass, press, rectCenter, rectOf, settledState, sleep } from './helpers.js';

const PAGE = 'forms.html';

export const formsCases = [
  defineConformance({
    id: 'primitives.forms-checkbox.L1',
    family: 'forms',
    title: 'Checkbox toggles by click',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'option A');
      const on = await settledState(ctx, PAGE);
      if (on.checkA !== true) return fail('first click did not check the box');
      await clickByName(ctx, 'option A');
      const off = await settledState(ctx, PAGE);
      return off.checkA === false ? pass('checked then unchecked') : fail('second click did not uncheck');
    },
  }),

  defineConformance({
    id: 'primitives.forms-radio.L1',
    family: 'forms',
    title: 'Radio button selects by click',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'green');
      const s = await settledState(ctx, PAGE);
      return s.color === 'green' ? pass('green selected') : fail(`color=${JSON.stringify(s.color)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-submit-reset.L1',
    family: 'forms',
    title: 'Type, submit, then reset clears the form',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'name');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: 'Ada' });
      await clickByName(ctx, 'Submit', { role: 'button' });
      const mid = await settledState(ctx, PAGE);
      if (Number(mid.submits) < 1) return fail('no submit event');
      if (mid.name !== 'Ada') return fail(`name=${JSON.stringify(mid.name)} at submit time`);
      await clickByName(ctx, 'Reset', { role: 'button' });
      const s = await settledState(ctx, PAGE);
      return Number(s.resets) >= 1 && s.name === ''
        ? pass('submitted with value, reset cleared it')
        : fail(`resets=${String(s.resets)} name=${JSON.stringify(s.name)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-combobox-custom.L1',
    family: 'forms',
    title: 'Custom combobox: type to filter, click a suggestion',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'city (custom combobox)');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: 'par' });
      await sleep(400);
      await clickAt(ctx, rectCenter(await rectOf(ctx, PAGE, 'combo-opt-paris')));
      const s = await settledState(ctx, PAGE);
      return s.comboChosen === 'Paris' ? pass('typed "par", picked Paris') : fail(`comboChosen=${JSON.stringify(s.comboChosen)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-range-arrows.L1',
    family: 'forms',
    title: 'Range slider steps with ArrowRight',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'level range');
      await press(ctx, 'ArrowRight', { count: 5 });
      const s = await settledState(ctx, PAGE);
      return Number(s.range) === 25 ? pass('range 20→25 via arrows') : fail(`range=${String(s.range)}, wanted 25`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-date-typed.L1',
    family: 'forms',
    title: 'Date input accepts typed digits (per-key mode)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await focusByName(ctx, 'date field');
      // Segment order is locale-dependent; the year segment is 2030 either way.
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'key.type', text: '01022030', mode: 'keys' });
      const s = await settledState(ctx, PAGE);
      const v = String(s.date ?? '');
      return v.startsWith('2030')
        ? pass(`date=${v}`)
        : fail(`date=${JSON.stringify(v)} — per-key digits did not reach the segments`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-select-native.L1',
    family: 'forms',
    title: 'Native <select>: choose an option',
    requires: ['ACT-forms'],
    page: PAGE,
    async run(ctx) {
      // Needs form.setValue: the OS-drawn popup is unreachable by CDP input and
      // <option> children are absent from the snapshot.
      const snap = await ctx.driver.read(ctx.tabId);
      const t = ctx.driver.findRef(snap, 'fruit select');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'form.setValue', ref: t.ref, snapshotId: t.snapshotId, value: 'banana' });
      if (!r.ok) return fail(`form.setValue refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return s.fruit === 'banana' ? pass('banana selected via form.setValue') : fail(`fruit=${JSON.stringify(s.fruit)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-setvalue-verb.L1',
    family: 'forms',
    title: 'form.setValue fills a text input directly',
    requires: ['ACT-forms'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const t = ctx.driver.findRef(snap, 'name');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'form.setValue', ref: t.ref, snapshotId: t.snapshotId, value: 'Grace' });
      if (!r.ok) return fail(`form.setValue refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return s.name === 'Grace' ? pass('value set') : fail(`name=${JSON.stringify(s.name)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-upload.L1',
    family: 'forms',
    title: 'form.upload attaches a file to <input type=file>',
    requires: ['ACT-upload'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const t = ctx.driver.findRef(snap, 'doc file');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'form.upload', ref: t.ref, snapshotId: t.snapshotId, paths: ['report.txt'] });
      if (!r.ok) return fail(`form.upload refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return Number(s.fileCount) === 1 ? pass('file attached') : fail(`fileCount=${String(s.fileCount)}`);
    },
  }),

  defineConformance({
    id: 'primitives.forms-color.L1',
    family: 'forms',
    title: 'Color picker (OS-drawn dialog)',
    requires: ['ACT-forms'],
    outOfScope: 'the color swatch opens an OS-drawn picker no renderer-level input can reach; only form.setValue could set it, tracked by the setvalue case',
    page: PAGE,
  }),
];
