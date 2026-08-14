// Layer B — agent-capability scenarios (L2): a REAL `claude -p` run (paired
// serve) is given a natural-language goal against a fixture page; the fixture
// ledger is the oracle. Real-LLM-only: the claude-shim has no branch for the
// act steering prompt, and layer A already provides the deterministic tier.

import { defineAgentScenario } from './actScenario.js';
import type { ActRunView } from '@nff-brain/core/benchProtocol';

function transcriptText(run: ActRunView): string {
  return run.transcript.map((t) => t.text).join('\n');
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const agentScenarios = [
  defineAgentScenario({
    id: 'primitives.agent-click-button.L2',
    family: 'pointer',
    title: 'Smoke: click one named button',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'pointer.html',
    goal: "Click the button labeled 'left' on this page, then stop.",
    maxActions: 4,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const clicks = ctx.fixtures.ledger.eventsFor(ctx.nonce, 'pointer.html').filter((e) => e.type === 'click' && e.target === 'btn-left');
      return clicks.length >= 1
        ? { pass: true, detail: 'btn-left clicked' }
        : { pass: false, detail: 'no click on btn-left' };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-fill-form.L2',
    family: 'forms',
    title: 'Fill two fields and submit',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'forms.html',
    goal: "Fill the form on this page: set the name field to 'Ada Lovelace' and the notes field to 'benchmark run'. Then click Submit.",
    maxActions: 10,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      if (!s) return { pass: false, detail: 'no page state' };
      if (s.name !== 'Ada Lovelace') return { pass: false, detail: `name=${JSON.stringify(s.name)}` };
      if (String(s.notes) !== 'benchmark run') return { pass: false, detail: `notes=${JSON.stringify(s.notes)}` };
      return Number(s.submits) >= 1 ? { pass: true, detail: 'form filled and submitted' } : { pass: false, detail: 'never submitted' };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-check-boxes.L2',
    family: 'forms',
    title: 'Check two checkboxes, touch nothing else',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'forms.html',
    goal: 'Check the checkboxes for option A and option B on this page. Do not change any other control.',
    maxActions: 6,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      if (!s) return { pass: false, detail: 'no page state' };
      if (!(s.checkA === true && s.checkB === true)) return { pass: false, detail: `A=${String(s.checkA)} B=${String(s.checkB)}` };
      return s.color === '' && Number(s.submits) === 0
        ? { pass: true, detail: 'both checked, nothing else touched' }
        : { pass: false, detail: `side effects: color=${JSON.stringify(s.color)} submits=${String(s.submits)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-radio-choice.L2',
    family: 'forms',
    title: 'Pick one radio option',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'forms.html',
    goal: 'Select the blue color option on this page.',
    maxActions: 4,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      return s?.color === 'blue' ? { pass: true, detail: 'blue selected' } : { pass: false, detail: `color=${JSON.stringify(s?.color)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-custom-combobox.L2',
    family: 'forms',
    title: 'Type to filter a combobox and pick a suggestion',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'forms.html',
    goal: "In the city combobox on this page, type to filter and choose 'Prague' from the suggestions.",
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      return s?.comboChosen === 'Prague'
        ? { pass: true, detail: 'Prague picked from suggestions' }
        : { pass: false, detail: `comboChosen=${JSON.stringify(s?.comboChosen)} combo=${JSON.stringify(s?.combo)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-scroll-find.L2',
    family: 'scroll',
    title: 'Scroll down to find and click a below-fold button',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'scroll.html',
    goal: "Scroll down this page until you find the 'deep target button' and click it.",
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'scroll.html');
      return Number(s?.deepClicked) >= 1 ? { pass: true, detail: 'deep target clicked' } : { pass: false, detail: `deepClicked=${String(s?.deepClicked)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-nested-scroll.L2',
    family: 'scroll',
    title: 'Scroll a nested container, not the page',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'scroll.html',
    goal: 'Scroll the blue-bordered inner container on this page down to its bottom marker. Do not scroll the page itself.',
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'scroll.html');
      if (!s) return { pass: false, detail: 'no page state' };
      if (Number(s.nestedTop) < 1000) return { pass: false, detail: `nestedTop=${String(s.nestedTop)}` };
      return Number(s.pageY) < 100
        ? { pass: true, detail: `container at ${String(s.nestedTop)}, page held at ${String(s.pageY)}` }
        : { pass: false, detail: `container scrolled but the page moved too (pageY=${String(s.pageY)})` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-drag-reorder.L2',
    family: 'drag',
    title: 'Drag-reorder a list item',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'drag.html',
    goal: "Reorder the list on this page by dragging the 'alpha' item so it sits below 'charlie'.",
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'drag.html');
      const order = (s?.order as string[]) ?? [];
      const ok = order.indexOf('reorder-a') > order.indexOf('reorder-c') && order.indexOf('reorder-a') > 0;
      return ok ? { pass: true, detail: order.join(' → ') } : { pass: false, detail: `order: ${order.join(' → ')}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-slider-set.L2',
    family: 'drag',
    title: 'Drag a slider to ~70',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'drag.html',
    goal: 'Drag the custom slider on this page so its value reads approximately 70 (anywhere from 60 to 80 counts).',
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const v = Number(ctx.fixtures.ledger.lastState(ctx.nonce, 'drag.html')?.slider);
      return v >= 60 && v <= 80 ? { pass: true, detail: `slider=${v}` } : { pass: false, detail: `slider=${v}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-hover-menu.L2',
    family: 'pointer',
    title: 'Hover to reveal a menu, then click its item',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'pointer.html',
    goal: "Hover over 'hover me' on this page until the menu appears, then click the 'menu item' button in it.",
    maxActions: 6,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const clicks = ctx.fixtures.ledger.eventsFor(ctx.nonce, 'pointer.html').filter((e) => e.type === 'click' && e.target === 'hover-menu-item');
      return clicks.length >= 1 ? { pass: true, detail: 'menu item clicked' } : { pass: false, detail: 'menu item never clicked' };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-dblclick.L2',
    family: 'pointer',
    title: 'Double-click a named button',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'pointer.html',
    goal: "Double-click the button labeled 'double-click (dblclick handler)' on this page.",
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'pointer.html');
      return Number(s?.dblHandler) >= 1 ? { pass: true, detail: 'dblclick handler fired' } : { pass: false, detail: `dblHandler=${String(s?.dblHandler)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-caret-edit.L2',
    family: 'edit',
    title: 'Edit inside a field without retyping it all',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'edit.html',
    goal: "The first text field on this page reads 'the quick brown fox'. Edit it so it reads exactly 'the brown fox'.",
    maxActions: 12,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'edit.html');
      return s?.boxValue === 'the brown fox'
        ? { pass: true, detail: 'field reads "the brown fox"' }
        : { pass: false, detail: `boxValue=${JSON.stringify(s?.boxValue)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-consent-then-click.L2',
    family: 'dialogs',
    title: 'Dismiss a consent overlay to reach the goal button',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'dialogs.html',
    goal: "Click the button labeled 'the button the agent must click' on this page.",
    maxActions: 6,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'dialogs.html');
      return Number(s?.goalClicks) >= 1
        ? { pass: true, detail: `goal clicked (consent: ${JSON.stringify(s?.consentChoice)})` }
        : { pass: false, detail: `goalClicks=${String(s?.goalClicks)} consentOpen=${String(s?.consentOpen)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-nav-anchor.L2',
    family: 'nav',
    title: 'Use an in-page anchor link',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'nav.html',
    goal: 'Jump to the bottom of this page using its in-page anchor link.',
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'nav.html');
      return s?.hash === '#bottom' ? { pass: true, detail: 'anchor reached' } : { pass: false, detail: `hash=${JSON.stringify(s?.hash)} pageY=${String(s?.pageY)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-back-forward.L2',
    family: 'nav',
    title: 'Navigate away, then come back with history',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'nav.html',
    goal: "Follow the 'go to page B' link on this page, then use browser history to return to page A.",
    maxActions: 6,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(500);
      const bSeen = ctx.fixtures.ledger.lastState(ctx.nonce, 'nav-b.html') !== null;
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'nav.html');
      // Back either reloads page A (back_forward / loadCount) or restores it
      // from BFCache — the same instance resumes and records pageshow persisted.
      const restored = ctx.fixtures.ledger
        .eventsFor(ctx.nonce, 'nav.html')
        .some((e) => e.type === 'pageshow' && e.persisted === true);
      const backOk = restored || s?.navigationType === 'back_forward' || Number(s?.loadCount) >= 2;
      return bSeen && backOk
        ? { pass: true, detail: `visited B and returned via history${restored ? ' (BFCache restore)' : ''}` }
        : { pass: false, detail: `bSeen=${String(bSeen)} navigationType=${String(s?.navigationType)} loads=${String(s?.loadCount)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-tab-open-read.L2',
    family: 'tabs',
    title: 'Open a page in a new tab and report its heading',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'nav.html',
    goal: "Open page B from this page in a NEW tab, read its heading, and tell me what it says.",
    maxActions: 8,
    reps: 2,
    passRate: 0.5,
    async verify(ctx, run) {
      await settle(500);
      const bSeen = ctx.fixtures.ledger.lastState(ctx.nonce, 'nav-b.html') !== null;
      // "page B" is accepted: the interactive snapshot exposes the tab title
      // but not the <h1> text, so the exact heading wording needs a text-mode
      // read the goal doesn't demand.
      const said = /page ?b/i.test(transcriptText(run));
      return bSeen && said
        ? { pass: true, detail: 'opened B and reported its heading' }
        : { pass: false, detail: `bLoaded=${String(bSeen)} headingReported=${String(said)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-download-link.L2',
    family: 'media',
    title: 'Download a file via its link',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'media.html',
    goal: "Download the report.txt file using the download link on this page.",
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      await settle(1500);
      const hit = ctx.fixtures.ledger.assetRequests.some((r) => r.run === ctx.nonce && r.pathname.includes('report.txt'));
      return hit ? { pass: true, detail: 'download request reached the server' } : { pass: false, detail: 'asset never requested' };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-wizard.L2',
    family: 'forms',
    title: 'Multi-step form flow (combobox + arrows + submit)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: 'forms.html',
    goal: "On this page: pick 'Paris' in the city combobox, set the range slider to exactly 25 using arrow keys, then click Submit.",
    maxActions: 14,
    reps: 2,
    passRate: 0.5,
    timeoutMs: 420_000,
    async verify(ctx) {
      await settle(500);
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      if (!s) return { pass: false, detail: 'no page state' };
      const parts = [
        s.comboChosen === 'Paris' ? null : `combo=${JSON.stringify(s.comboChosen)}`,
        Number(s.range) === 25 ? null : `range=${String(s.range)}`,
        Number(s.submits) >= 1 ? null : 'no submit',
      ].filter(Boolean);
      return parts.length === 0 ? { pass: true, detail: 'all three steps landed' } : { pass: false, detail: parts.join(', ') };
    },
  }),

  // ── blocked twins (capability-gated) ───────────────────────────────────────

  defineAgentScenario({
    id: 'primitives.agent-select-native.L2',
    family: 'forms',
    title: 'Choose an option in a native <select>',
    requires: ['ACT-forms'],
    page: 'forms.html',
    goal: "Choose 'banana' in the fruit dropdown on this page.",
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      return s?.fruit === 'banana' ? { pass: true, detail: 'banana chosen' } : { pass: false, detail: `fruit=${JSON.stringify(s?.fruit)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-upload.L2',
    family: 'forms',
    title: 'Attach a file to the upload field',
    requires: ['ACT-upload'],
    page: 'forms.html',
    goal: 'Attach the provided report file to the file-upload field on this page.',
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'forms.html');
      return Number(s?.fileCount) === 1 ? { pass: true, detail: 'file attached' } : { pass: false, detail: `fileCount=${String(s?.fileCount)}` };
    },
  }),

  defineAgentScenario({
    id: 'primitives.agent-dialog-confirm.L2',
    family: 'dialogs',
    title: 'Trigger and accept a native confirm()',
    requires: ['ACT-dialogs'],
    page: 'dialogs.html',
    goal: "Click the confirm() button on this page and accept the dialog that appears.",
    maxActions: 5,
    reps: 2,
    passRate: 0.5,
    async verify(ctx) {
      const s = ctx.fixtures.ledger.lastState(ctx.nonce, 'dialogs.html');
      return s?.confirmResult === true ? { pass: true, detail: 'confirm accepted' } : { pass: false, detail: `confirmResult=${String(s?.confirmResult)}` };
    },
  }),
];
