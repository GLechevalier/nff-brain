// Dialog-family cases (layer A). The consent banner is DOM and runnable
// today; the NATIVE dialog cases stay blocked on ACT-dialogs — running one
// now would freeze the renderer's main thread with no way to dismiss it
// (Page.javascriptDialogOpening is never subscribed) and wedge the whole run.

import { defineConformance } from '../actScenario.js';
import { clickByName, fail, pass, settledState } from './helpers.js';

const PAGE = 'dialogs.html';

export const dialogsCases = [
  defineConformance({
    id: 'primitives.dialogs-consent-banner.L1',
    family: 'dialogs',
    title: 'Full-screen consent overlay blocks a click until dismissed',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const snap = await ctx.driver.read(ctx.tabId);
      const goal = ctx.driver.findRef(snap, 'the button the agent must click', 'button');
      const refused = await ctx.driver.verb(ctx.tabId, { kind: 'pointer.click', target: goal, button: 'left', clickCount: 1 });
      if (refused.ok) return fail('click went through the consent overlay');
      await clickByName(ctx, 'Accept all');
      await clickByName(ctx, 'the button the agent must click');
      const s = await settledState(ctx, PAGE);
      if (s.consentChoice !== 'accept') return fail(`consentChoice=${JSON.stringify(s.consentChoice)}`);
      return Number(s.goalClicks) >= 1
        ? pass('blocked while open, clickable after Accept')
        : fail('overlay dismissed but the goal click never landed');
    },
  }),

  defineConformance({
    id: 'primitives.dialogs-alert.L1',
    family: 'dialogs',
    title: 'Dismiss a native alert()',
    requires: ['ACT-dialogs'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'alert()');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'dialog.handle', accept: true });
      if (!r.ok) return fail(`dialog.handle refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return Number(s.alerts) >= 1 ? pass('alert fired and was dismissed') : fail(`alerts=${String(s.alerts)}`);
    },
  }),

  defineConformance({
    id: 'primitives.dialogs-confirm.L1',
    family: 'dialogs',
    title: 'Accept a native confirm()',
    requires: ['ACT-dialogs'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'confirm()');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'dialog.handle', accept: true });
      if (!r.ok) return fail(`dialog.handle refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return s.confirmResult === true ? pass('confirm accepted') : fail(`confirmResult=${String(s.confirmResult)}`);
    },
  }),

  defineConformance({
    id: 'primitives.dialogs-prompt.L1',
    family: 'dialogs',
    title: 'Answer a native prompt() with text',
    requires: ['ACT-dialogs'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'prompt()');
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'dialog.handle', accept: true, promptText: 'bench-answer' });
      if (!r.ok) return fail(`dialog.handle refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return s.promptResult === 'bench-answer' ? pass('prompt answered') : fail(`promptResult=${JSON.stringify(s.promptResult)}`);
    },
  }),

  defineConformance({
    id: 'primitives.dialogs-beforeunload.L1',
    family: 'dialogs',
    title: 'Leave-site (beforeunload) prompt handled on reload',
    requires: ['ACT-dialogs'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'arm beforeunload');
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.reload' });
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'dialog.handle', accept: true });
      if (!r.ok) return fail(`dialog.handle refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE, 1500);
      return Number(s.loadCount) >= 2 ? pass('left the page through the prompt') : fail(`loadCount=${String(s.loadCount)}`);
    },
  }),
];
