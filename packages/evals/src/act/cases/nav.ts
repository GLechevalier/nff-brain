// Navigation-family conformance cases (layer A). Page A = nav.html propagates
// the run nonce into its links, so page B's reports land in the same ledger.

import { defineConformance } from '../actScenario.js';
import { clickByName, fail, pass, settledState, sleep } from './helpers.js';

const PAGE = 'nav.html';
const PAGE_B = 'nav-b.html';

export const navCases = [
  defineConformance({
    id: 'primitives.nav-goto.L1',
    family: 'nav',
    title: 'nav.goto lands on a URL with query parameters intact',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.goto', url: ctx.pageUrl(PAGE, { q: 'zebra' }) });
      await sleep(800);
      const s = await settledState(ctx, PAGE);
      return s.q === 'zebra' ? pass('landed with ?q=zebra') : fail(`page saw q=${JSON.stringify(s.q)}`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-query-edit.L1',
    family: 'nav',
    title: 'Editing a query parameter re-navigates the same page',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.goto', url: ctx.pageUrl(PAGE, { q: 'first' }) });
      await sleep(600);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.goto', url: ctx.pageUrl(PAGE, { q: 'second' }) });
      await sleep(600);
      const s = await settledState(ctx, PAGE);
      return s.q === 'second' && Number(s.loadCount) >= 2
        ? pass(`q=second on load #${String(s.loadCount)}`)
        : fail(`q=${JSON.stringify(s.q)}, loadCount=${String(s.loadCount)}`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-hash-anchor.L1',
    family: 'nav',
    title: 'Clicking an in-page #anchor link jumps to the anchor',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'jump to #bottom');
      await sleep(600);
      const s = await settledState(ctx, PAGE);
      const hash = String(s.hash ?? '');
      const y = Number(s.pageY);
      if (hash !== '#bottom') return fail(`hash=${JSON.stringify(hash)}`);
      return y > 1000 ? pass(`hash set, page jumped to y=${y}`) : fail(`hash set but pageY=${y}`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-link-same-tab.L1',
    family: 'nav',
    title: 'Clicking a link navigates the same tab',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'go to page B');
      await sleep(1000);
      const snap = await ctx.driver.read(ctx.tabId);
      const sB = ctx.fixtures.ledger.lastState(ctx.nonce, PAGE_B);
      return snap.title === 'page B' && sB !== null
        ? pass('tab is on page B and page B reported in')
        : fail(`title=${JSON.stringify(snap.title)}, pageB reported=${String(sB !== null)}`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-link-new-tab.L1',
    family: 'nav',
    title: 'A target=_blank link opens a new tab',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'open page B in a new tab');
      await sleep(1200);
      const tabs = await ctx.driver.listTabs();
      const opened = tabs.filter((t) => t.url.includes(PAGE_B) && t.tabId !== ctx.tabId);
      for (const t of opened) await ctx.driver.closeTab(t.tabId);
      return opened.length === 1
        ? pass('page B opened in its own tab')
        : fail(`${opened.length} new tab(s) with page B`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-back-forward.L1',
    family: 'nav',
    title: 'nav.back and nav.forward walk history',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'go to page B');
      await sleep(1000);
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.back' });
      await sleep(1200);
      // Back either reloads page A (navigationType back_forward) or restores
      // it from BFCache (same instance resumes; a pageshow persisted event).
      const back = await settledState(ctx, PAGE);
      const restored = ctx.fixtures.ledger.eventsFor(ctx.nonce, PAGE).some((e) => e.type === 'pageshow' && e.persisted === true);
      if (back.navigationType !== 'back_forward' && !restored) {
        return fail(`back landed with navigationType=${String(back.navigationType)} and no BFCache restore`);
      }
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.forward' });
      await sleep(1000);
      const snap = await ctx.driver.read(ctx.tabId);
      return snap.title === 'page B'
        ? pass('back to A (back_forward), forward to B')
        : fail(`after forward, title=${JSON.stringify(snap.title)}`);
    },
  }),

  defineConformance({
    id: 'primitives.nav-reload.L1',
    family: 'nav',
    title: 'nav.reload reloads the page',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await ctx.driver.mustVerb(ctx.tabId, { kind: 'nav.reload' });
      await sleep(1000);
      const s = await settledState(ctx, PAGE);
      return Number(s.loadCount) >= 2 && s.navigationType === 'reload'
        ? pass(`reloaded (load #${String(s.loadCount)})`)
        : fail(`loadCount=${String(s.loadCount)}, navigationType=${String(s.navigationType)}`);
    },
  }),
];
