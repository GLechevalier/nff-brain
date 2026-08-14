// Out-of-scope rows — registered so the scorecard documents the boundary, but
// NEVER executed: each is structurally impossible for a Chrome-extension agent
// driving pages via chrome.debugger, not merely unimplemented.

import { defineConformance } from '../actScenario.js';

export const oosCases = [
  defineConformance({
    id: 'primitives.oos-captcha.L1',
    family: 'oos',
    title: 'Solve a CAPTCHA',
    requires: ['ACT-harness'],
    outOfScope:
      'prohibited by the agent steering prompt, and structurally unreachable anyway: CAPTCHAs live in cross-origin iframes the snapshot never traverses',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-os-file-dialog.L1',
    family: 'oos',
    title: 'Drive the OS file-open dialog',
    requires: ['ACT-harness'],
    outOfScope: 'an OS-drawn dialog is outside the page; renderer-level CDP input cannot reach it (file upload goes through form.upload instead)',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-incognito.L1',
    family: 'oos',
    title: 'Open a private/incognito window',
    requires: ['ACT-harness'],
    outOfScope: 'the manifest sets "incognito": "not_allowed" — the extension does not exist in incognito contexts',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-devtools.L1',
    family: 'oos',
    title: 'Open DevTools / inspect an element',
    requires: ['ACT-harness'],
    outOfScope: 'Chrome allows one debugger per tab — DevTools open on the target evicts the agent, and the agent cannot open DevTools',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-browser-settings.L1',
    family: 'oos',
    title: 'Change browser settings / manage extensions / bookmarks / history',
    requires: ['ACT-harness'],
    outOfScope: 'chrome:// pages are rejected by isRestrictedUrl and undrivable by chrome.debugger; no bookmarks/history permissions exist',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-browser-shortcuts.L1',
    family: 'oos',
    title: 'Browser-UI shortcuts (Ctrl+T/W/L, F11, F12, Ctrl+F find bar)',
    requires: ['ACT-harness'],
    outOfScope:
      'CDP key events are dispatched into the RENDERER; browser-chrome accelerators never see them (tab verbs and page.find cover the intents instead)',
    page: 'idle.html',
  }),
  defineConformance({
    id: 'primitives.oos-print.L1',
    family: 'oos',
    title: 'Print / save as PDF',
    requires: ['ACT-harness'],
    outOfScope: 'the print dialog is browser UI; Page.printToPDF would need a new verb and a file-delivery channel (candidate for a future capability)',
    page: 'idle.html',
  }),
];
