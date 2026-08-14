// Tabs-family conformance cases (layer A). tab.open/switch/duplicate return
// newTabId; the engine re-attaches the debugger to whichever tab it drives.

import { defineConformance } from '../actScenario.js';
import { fail, pass, sleep } from './helpers.js';

const PAGE = 'tabs.html';

export const tabsCases = [
  defineConformance({
    id: 'primitives.tabs-open-switch.L1',
    family: 'tabs',
    title: 'tab.open a second page, then tab.switch back',
    requires: ['ACT-harness', 'ACT-engine'],
    knownGap:
      "tab.open races the new tab's initial about:blank: switchTo() runs before the URL commits and isRestrictedUrl refuses it (needs a wait-for-commit like nav.goto's)",
    page: PAGE,
    async run(ctx) {
      const opened = await ctx.driver.verb(ctx.tabId, { kind: 'tab.open', url: ctx.pageUrl('nav-b.html'), active: true });
      if (!opened.ok || opened.newTabId === undefined) return fail(`tab.open: ${opened.resultText}`);
      const newTab = opened.newTabId;
      await sleep(800);
      const onB = await ctx.driver.read(newTab);
      if (onB.title !== 'page B') return fail(`new tab shows ${JSON.stringify(onB.title)}`);
      const back = await ctx.driver.verb(newTab, { kind: 'tab.switch', tabId: ctx.tabId });
      if (!back.ok) return fail(`tab.switch back: ${back.resultText}`);
      const tabs = await ctx.driver.listTabs();
      const active = tabs.find((t) => t.active);
      await ctx.driver.closeTab(newTab);
      return active?.tabId === ctx.tabId
        ? pass('opened page B, switched back, original tab active')
        : fail(`active tab is ${String(active?.tabId)}, expected ${ctx.tabId}`);
    },
  }),

  defineConformance({
    id: 'primitives.tabs-duplicate.L1',
    family: 'tabs',
    title: 'tab.duplicate clones the current tab',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      const dup = await ctx.driver.verb(ctx.tabId, { kind: 'tab.duplicate', tabId: ctx.tabId });
      if (!dup.ok || dup.newTabId === undefined) return fail(`tab.duplicate: ${dup.resultText}`);
      await sleep(800);
      const tabs = await ctx.driver.listTabs();
      const twins = tabs.filter((t) => t.url.includes(`run=${ctx.nonce}`) && t.url.includes(PAGE));
      await ctx.driver.verb(dup.newTabId, { kind: 'tab.switch', tabId: ctx.tabId }).catch(() => undefined);
      await ctx.driver.closeTab(dup.newTabId);
      return twins.length === 2 ? pass('duplicate exists alongside the original') : fail(`${twins.length} copies visible`);
    },
  }),

  defineConformance({
    id: 'primitives.tabs-close.L1',
    family: 'tabs',
    title: 'tab.close removes a tab (destructive-class verb)',
    requires: ['ACT-harness', 'ACT-engine'],
    knownGap:
      'two stacked bugs: validateBrowserVerb drops active:false (only copies active===true), so the background-open this case asks for silently becomes an active open — which then hits the tab.open about:blank race',
    page: PAGE,
    async run(ctx) {
      const opened = await ctx.driver.verb(ctx.tabId, { kind: 'tab.open', url: ctx.pageUrl('nav-b.html'), active: false });
      if (!opened.ok || opened.newTabId === undefined) return fail(`tab.open: ${opened.resultText}`);
      const victim = opened.newTabId;
      await sleep(500);
      const closed = await ctx.driver.verb(ctx.tabId, { kind: 'tab.close', tabId: victim });
      if (!closed.ok) return fail(`tab.close: ${closed.resultText}`);
      await sleep(300);
      const tabs = await ctx.driver.listTabs();
      return tabs.some((t) => t.tabId === victim) ? fail('closed tab still listed') : pass('tab closed');
    },
  }),
];
