// The LLM's action tools: a small granular set (read_page, pointer, keyboard,
// scroll, navigate) each a thin adapter that maps the model's tool call onto a
// validated BrowserVerb (@nff-brain/core), runs it through the origin gate, and
// dispatches it via actEngine. NOTHING here is free-form: every call becomes an
// enumerated, validated verb — the "wide but still fixed" vocabulary, no eval.
//
// No module-level mutable state. The per-run mutable bits (budget counter, stop
// latch, session grants) live in the ActContext the run passes in.

import type { BrowserVerb, Modifiers, Target } from '@nff-brain/core/browserVerbs';
import { validateBrowserVerb, verbClass } from '@nff-brain/core/browserVerbs';
import { renderSnapshotText } from '@nff-brain/core/pageSnapshot';
import { extractJson } from '@nff-brain/core/jsonExtract';
import type { WorkflowSpec } from '@nff-brain/core/workflow';
import type { ToolSpec } from '@nff-brain/core/provider';
import type { ToolExecutor } from './providerClient.js';
import { decideAct, originOf } from './actGate.js';
import { executeVerb } from './actEngine.js';
import { appendTranscript, mutateActRun } from './actStore.js';
import { getActHostAllow, getActRun } from './storage.js';
import { KEYS } from './schema.js';
import type { ActManualCapability, ActPendingGrant, ActRunState } from './schema.js';

export interface ActContext {
  tabId: number;
  /** Correlates a paused runVerb() with the run it's waiting on — see waitForGrantAnswer. */
  runId: string;
  /** The chat mode the run started under — only 'manual' asks per-capability. */
  mode: 'manual' | 'plan' | 'auto';
  /** Toward maxActions — counts interact/navigate/destructive verbs, not reads. */
  actionsTaken: number;
  maxActions: number;
  /** Origins granted "once" this run (plus persisted "always" from storage). */
  grantedOrigins: string[];
  /** Manual mode's "Always" answers so far this run — mirrors ActRunState.manualGrants. */
  manualGrants: Partial<Record<ActManualCapability, true>>;
  /** Latched true by Stop / budget so in-flight executors short-circuit. */
  stopped: boolean;
}

/** Short, human description of a verb for the manual-mode capability prompt. Pre-execution, so it names the ACTION, not the resolved element (the transcript line fills that in afterward). */
function describeVerb(verb: BrowserVerb): string {
  switch (verb.kind) {
    case 'page.read':
      return 'read the page';
    case 'page.find':
      return 'search the page';
    case 'page.screenshot':
      return 'take a screenshot';
    case 'page.zoom':
      return 'zoom the page';
    case 'tab.list':
      return 'list open tabs';
    case 'pointer.click':
      return `${verb.button} click`;
    case 'pointer.move':
    case 'touch.tap':
      return 'move the pointer';
    case 'pointer.down':
    case 'pointer.up':
      return 'press the mouse button';
    case 'pointer.drag':
    case 'touch.swipe':
      return 'drag on the page';
    case 'scroll.wheel':
      return 'scroll the page';
    case 'scroll.intoView':
      return 'scroll an element into view';
    case 'key.press':
      return `press ${verb.key}`;
    case 'key.type':
      return 'type text';
    case 'element.focus':
      return 'focus an element';
    case 'form.setValue':
      return 'fill in a field';
    case 'form.upload':
      return 'upload a file';
    case 'tab.close':
      return 'close a tab';
    case 'dialog.handle':
      return 'handle a dialog';
    default:
      return verb.kind;
  }
}

/**
 * Pause the run on a fresh pendingGrant and wait for the panel to answer it —
 * event-driven off chrome.storage.onChanged, same pattern as actRun.ts's
 * watchForStop, kept local here since actRun.ts imports THIS module (a reverse
 * import would cycle). Resolves 'never' (deny, don't stop the run) if the run
 * is stopped/cleared/replaced while waiting, so a paused verb can never hang
 * a run that the user has already abandoned.
 */
async function requestGrant(runId: string, grant: ActPendingGrant): Promise<'once' | 'always' | 'never'> {
  const posted = await mutateActRun((r) => {
    r.phase = 'awaiting_grant';
    r.pendingGrant = grant;
    r.pendingGrantChoice = null;
  });
  if (!posted) return 'never';
  return new Promise((resolve) => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local' || !(KEYS.actRun in changes)) return;
      const v = changes[KEYS.actRun]!.newValue as ActRunState | null | undefined;
      if (!v || v.id !== runId || v.phase !== 'awaiting_grant') {
        chrome.storage.onChanged.removeListener(listener);
        resolve('never');
        return;
      }
      if (v.pendingGrantChoice != null) {
        chrome.storage.onChanged.removeListener(listener);
        resolve(v.pendingGrantChoice);
      }
    };
    chrome.storage.onChanged.addListener(listener);
  });
}

export const ACT_STEERING = [
  'You are the nff-brain web agent, driving a browser tab with a real cursor the user can watch. Use the tabs tool to see what other tabs are open and to switch which tab you are driving.',
  'Work toward the GOAL below using the tools. Always call read_page first, and again after anything changes the page (a click that navigates, a submit, a tab switch) — element refs (e1, e2, …) are only valid for the most recent read_page.',
  'Prefer refs over raw coordinates. Take the smallest next step, observe, then continue.',
  'NEVER enter passwords, payment details, or other credentials. NEVER attempt to solve a CAPTCHA or bot check — if you hit one, stop and tell the user.',
  'When the goal is done (or you are blocked and need the user), stop calling tools and reply with a short plain summary of what you did.',
].join(' ');

export function buildSteeringPrompt(goal: string): string {
  return `${ACT_STEERING}\n\nGOAL: ${goal}`;
}

/**
 * Steering for replaying a saved workflow: the generalized steps plus the
 * user's concrete request, from which the agent binds the parameters. The steps
 * are re-grounded against the LIVE page (targets re-found, not replayed) — the
 * whole point of a generalizable workflow rather than a brittle macro.
 */
export function buildWorkflowRunPrompt(spec: WorkflowSpec, goal: string): string {
  const params = spec.params.length
    ? spec.params.map((p) => `- ${p.name}: ${p.description} (recorded example: ${p.example})`).join('\n')
    : '(none)';
  const stepLines: string[] = [];
  let n = 1;
  for (const s of spec.steps) {
    stepLines.push(`${n}. ${s.intent}`);
    if (s.loop) {
      const times = s.loop.countParam ? `{${s.loop.countParam}} times` : `for each ${s.loop.over}`;
      stepLines.push(`   repeat ${times}:`);
      for (const b of s.loop.body) stepLines.push(`     - ${b.intent}`);
    }
    n++;
  }
  return [
    ACT_STEERING,
    '',
    'You are REPLAYING a saved workflow. Follow its steps in order, but re-find every target on the LIVE page — never assume a position from the recording. Infer the parameter values from the USER REQUEST.',
    '',
    `WORKFLOW: ${spec.intent || 'recorded task'}`,
    `Site: ${spec.site}`,
    `Parameters:\n${params}`,
    `Steps:\n${stepLines.join('\n')}`,
    spec.successCriteria ? `Done when: ${spec.successCriteria}` : '',
    '',
    `USER REQUEST: ${goal}`,
    '',
    `If you are not already on ${spec.site}, navigate there first, then read_page and work through the steps. Stop and summarize when done or blocked.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── tool specs ───────────────────────────────────────────────────────────────

const READ_PAGE: ToolSpec = {
  name: 'read_page',
  description: 'Read the current page into a list of interactive elements with refs (e1, e2, …), plus scroll position. Call before acting and after the page changes.',
  input_schema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['interactive', 'text'], description: 'interactive (default) lists elements; text extracts the main text.' } },
  },
};
const POINTER: ToolSpec = {
  name: 'pointer',
  description: 'Mouse action on the page. Target by ref (preferred) or x/y. drag needs a second target (toRef or toX/toY).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'dblclick', 'tripleclick', 'rightclick', 'middleclick', 'hover', 'drag'] },
      ref: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      toRef: { type: 'string' },
      toX: { type: 'number' },
      toY: { type: 'number' },
      modifiers: { type: 'object', properties: { alt: { type: 'boolean' }, ctrl: { type: 'boolean' }, meta: { type: 'boolean' }, shift: { type: 'boolean' } } },
    },
    required: ['action'],
  },
};
const KEYBOARD: ToolSpec = {
  name: 'keyboard',
  description: 'Type text into the focused field (action:type, text) or press a key (action:press, key). Keys: Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown, Space, or a single character (with modifiers for shortcuts like ctrl+a).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['type', 'press'] },
      text: { type: 'string' },
      key: { type: 'string' },
      count: { type: 'number' },
      modifiers: { type: 'object', properties: { alt: { type: 'boolean' }, ctrl: { type: 'boolean' }, meta: { type: 'boolean' }, shift: { type: 'boolean' } } },
    },
    required: ['action'],
  },
};
const SCROLL: ToolSpec = {
  name: 'scroll',
  description: 'Scroll by dx/dy at a point (ref or x/y) so nested containers scroll where the pointer is. ctrl:true zooms instead.',
  input_schema: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      dx: { type: 'number' },
      dy: { type: 'number' },
      ctrl: { type: 'boolean' },
    },
  },
};
const NAVIGATE: ToolSpec = {
  name: 'navigate',
  description: 'Navigate the tab: goto (url), back, forward, or reload (hard optional).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] },
      url: { type: 'string' },
      hard: { type: 'boolean' },
    },
    required: ['action'],
  },
};
const TABS: ToolSpec = {
  name: 'tabs',
  description:
    'List open browser tabs, or switch/open/duplicate/close one. Call action:list first to see tab ids, titles, and urls before switching — switching makes that tab the one you drive next, so read_page again afterward.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'open', 'close', 'duplicate'] },
      tabId: { type: 'number', description: 'Required for switch, close, duplicate — from a prior list.' },
      url: { type: 'string', description: 'Required for open.' },
    },
    required: ['action'],
  },
};

// ── tool input → verb ────────────────────────────────────────────────────────

function targetFrom(input: Record<string, unknown>, refKey: string, xKey: string, yKey: string, snapshotId: string): Target | null {
  if (typeof input[refKey] === 'string') return { ref: input[refKey] as string, snapshotId };
  if (typeof input[xKey] === 'number' && typeof input[yKey] === 'number') return { x: input[xKey] as number, y: input[yKey] as number };
  return null;
}

const CLICK_MAP: Record<string, { button: 'left' | 'right' | 'middle'; clickCount: 1 | 2 | 3 } | 'hover' | 'drag'> = {
  click: { button: 'left', clickCount: 1 },
  dblclick: { button: 'left', clickCount: 2 },
  tripleclick: { button: 'left', clickCount: 3 },
  rightclick: { button: 'right', clickCount: 1 },
  middleclick: { button: 'middle', clickCount: 1 },
  hover: 'hover',
  drag: 'drag',
};

/** Map a validated tool call onto a raw verb object (still un-validated). `snapshotId` grounds refs to the latest read. */
function toVerbInput(name: string, input: Record<string, unknown>, snapshotId: string): unknown {
  const mods = input.modifiers as Modifiers | undefined;
  switch (name) {
    case 'read_page':
      return { kind: 'page.read', mode: input.mode };
    case 'pointer': {
      const spec = CLICK_MAP[String(input.action)];
      if (spec === 'hover') return { kind: 'pointer.move', target: targetFrom(input, 'ref', 'x', 'y', snapshotId) };
      if (spec === 'drag')
        return {
          kind: 'pointer.drag',
          from: targetFrom(input, 'ref', 'x', 'y', snapshotId),
          to: targetFrom(input, 'toRef', 'toX', 'toY', snapshotId),
          modifiers: mods,
        };
      if (!spec) return null;
      return { kind: 'pointer.click', target: targetFrom(input, 'ref', 'x', 'y', snapshotId), button: spec.button, clickCount: spec.clickCount, modifiers: mods };
    }
    case 'keyboard':
      if (input.action === 'type') return { kind: 'key.type', text: input.text };
      return { kind: 'key.press', key: input.key, modifiers: mods, count: input.count };
    case 'scroll':
      return { kind: 'scroll.wheel', target: targetFrom(input, 'ref', 'x', 'y', snapshotId), dx: input.dx ?? 0, dy: input.dy ?? 0, modifiers: input.ctrl ? { ctrl: true } : undefined };
    case 'navigate':
      if (input.action === 'goto') return { kind: 'nav.goto', url: input.url };
      if (input.action === 'reload') return { kind: 'nav.reload', hard: input.hard };
      return { kind: `nav.${input.action}` };
    case 'tabs':
      if (input.action === 'list') return { kind: 'tab.list' };
      if (input.action === 'switch') return { kind: 'tab.switch', tabId: input.tabId };
      if (input.action === 'open') return { kind: 'tab.open', url: input.url, active: true };
      if (input.action === 'close') return { kind: 'tab.close', tabId: input.tabId };
      if (input.action === 'duplicate') return { kind: 'tab.duplicate', tabId: input.tabId };
      return null;
    default:
      return null;
  }
}

async function currentOrigin(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return originOf(tab.url);
  } catch {
    return null;
  }
}

/**
 * Run one verb through the gate + engine. `ctx` carries the budget/stop/session
 * state. Returns the tool_result text the model sees. NEVER throws.
 */
async function runVerb(ctx: ActContext, verb: BrowserVerb, snapshotIdRef: { id: string }): Promise<{ ok: boolean; resultText: string }> {
  if (ctx.stopped) return { ok: false, resultText: 'the run was stopped' };
  const cls = verbClass(verb);

  if (cls !== 'observe') {
    if (ctx.actionsTaken >= ctx.maxActions) {
      ctx.stopped = true;
      return { ok: false, resultText: `action budget of ${ctx.maxActions} reached — stopping` };
    }
  }

  // Gate everything except navigate (see decideAct's doc comment: navigate is
  // exempt from both the manual-capability layer and the origin layer). Manual
  // mode pulls 'observe' into the gate too, which is why this can no longer
  // live inside the old `if (cls !== 'observe')` block above.
  if (cls !== 'navigate') {
    // tab.close targets a tab that may not be the one currently driven — gate on
    // ITS origin, not ctx.tabId's, or closing an unrelated tab would be judged
    // against the wrong site's grant.
    const origin = verb.kind === 'tab.close' ? await currentOrigin(verb.tabId) : await currentOrigin(ctx.tabId);
    const persisted = origin ? (await getActHostAllow()).byOrigin[origin] : undefined;
    const manualCap = cls as ActManualCapability; // safe: cls is 'observe'|'interact'|'destructive' here, navigate excluded above
    const manualGranted = ctx.mode !== 'manual' || !!ctx.manualGrants[manualCap];
    const decision = decideAct({
      verbClass: cls,
      persisted,
      sessionGranted: origin != null && ctx.grantedOrigins.includes(origin),
      mode: ctx.mode,
      manualGranted,
    });
    if (decision === 'deny') return { ok: false, resultText: `blocked — you set ${origin} to never allow actions` };
    if (decision === 'prompt') {
      const isManualGate = ctx.mode === 'manual' && !manualGranted;
      const grant: ActPendingGrant = isManualGate
        ? { kind: 'capability', verbClass: manualCap, description: describeVerb(verb) }
        : { kind: 'origin', origin: origin ?? '', verbClass: cls };
      const choice = await requestGrant(ctx.runId, grant);
      if (choice === 'never') {
        return {
          ok: false,
          resultText: isManualGate ? 'the user declined this action' : `blocked — you set ${origin ?? 'this site'} to never allow actions`,
        };
      }
      if (isManualGate) {
        if (choice === 'always') ctx.manualGrants[manualCap] = true;
      } else if (origin && !ctx.grantedOrigins.includes(origin)) {
        ctx.grantedOrigins.push(origin);
      }
    }
  }

  const res = await executeVerb(ctx.tabId, verb);
  // A tab.switch / active tab.open / tab.duplicate rebinds which tab is driven:
  // old element refs no longer apply, so drop them and persist the new tabId.
  if (res.newTabId !== undefined && res.newTabId !== ctx.tabId) {
    const newTabId = res.newTabId;
    ctx.tabId = newTabId;
    snapshotIdRef.id = '';
    await mutateActRun((r) => { r.tabId = newTabId; });
  }
  if (res.snapshot) snapshotIdRef.id = res.snapshot.snapshotId;
  if (cls !== 'observe' && res.ok) ctx.actionsTaken++;
  await appendTranscript({ kind: res.snapshot ? 'result' : 'action', text: res.resultText, ok: res.ok });
  if (cls !== 'observe') await mutateActRun((r) => { r.actionsTaken = ctx.actionsTaken; });
  // On a page.read, hand the model the rendered snapshot text; otherwise the short delta.
  if (res.snapshot) return { ok: true, resultText: renderSnapshotText(res.snapshot) };
  return { ok: res.ok, resultText: res.resultText };
}

/**
 * Build the tool executors for a run. `snapshotIdRef` is shared mutable state
 * threading the latest snapshot id from read_page into ref-based actions in the
 * same turn, without a page round trip.
 */
export function buildActTools(ctx: ActContext): ToolExecutor[] {
  const snapshotIdRef = { id: '' };
  const make = (spec: ToolSpec): ToolExecutor => ({
    spec,
    run: async (input) => {
      const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const raw = toVerbInput(spec.name, obj, snapshotIdRef.id);
      const verb = validateBrowserVerb(raw);
      if (!verb) return { ok: false, resultText: `invalid ${spec.name} arguments` };
      // A ref-based action before any read_page has no snapshot to ground it.
      if (spec.name !== 'read_page' && spec.name !== 'navigate' && !snapshotIdRef.id && rawUsesRef(raw))
        return { ok: false, resultText: 'call read_page first to get element refs' };
      return runVerb(ctx, verb, snapshotIdRef);
    },
  });
  return [READ_PAGE, POINTER, KEYBOARD, SCROLL, NAVIGATE, TABS].map(make);
}

function rawUsesRef(raw: unknown): boolean {
  const s = JSON.stringify(raw);
  return /"ref"|"toRef"/.test(s);
}

/** Re-exported so actRun can note when nothing was configured. */
export async function hasActiveRun(): Promise<boolean> {
  const r = await getActRun();
  return !!r && (r.phase === 'running' || r.phase === 'awaiting_grant');
}

// ── paired-mode JSON-action loop (claude -p, no API key) ─────────────────────
//
// BYOK mode uses the Anthropic tool_use protocol (runChatWithTools). The paired
// server's `claude -p` is a text one-shot, so paired mode uses a JSON contract:
// the model replies with ONE {action, args} object per turn, we execute it with
// the SAME executors, and feed the result back as text. Same engine, same gate,
// same budget — only the transport differs.

const ACT_JSON_TOOLS = [READ_PAGE, POINTER, KEYBOARD, SCROLL, NAVIGATE, TABS];

/** The tool contract, rendered as text for the claude -p prompt. */
export function renderActContract(): string {
  const tools = ACT_JSON_TOOLS.map((t) => `  ${t.name} — ${t.description}`).join('\n');
  return [
    'Control the browser by replying with EXACTLY ONE JSON object and NOTHING else:',
    '  {"action":"<tool>","args":{...}}  to act',
    '  {"done":true,"summary":"<what you did>"}  when the goal is met or you are blocked and need the user',
    'Tools:',
    tools,
  ].join('\n');
}

export type ActAction =
  | { kind: 'action'; name: string; args: Record<string, unknown> }
  | { kind: 'done'; summary: string }
  | { kind: 'invalid' };

/** Parse one claude -p turn into an action. Tolerant: prose around the JSON is fine. */
export function parseActAction(text: string): ActAction {
  const obj = extractJson<Record<string, unknown>>(text);
  if (!obj) return { kind: 'invalid' };
  if (obj.done === true || obj.action === 'done') return { kind: 'done', summary: typeof obj.summary === 'string' ? obj.summary : '' };
  if (typeof obj.action === 'string') {
    const args = obj.args && typeof obj.args === 'object' ? (obj.args as Record<string, unknown>) : {};
    return { kind: 'action', name: obj.action, args };
  }
  return { kind: 'invalid' };
}

/** Build the per-turn prompt for the paired loop: steering + goal + contract + history. */
export function buildPairedActPrompt(systemPrompt: string, history: string[]): string {
  const hist = history.length ? history.join('\n') : '(nothing yet — start by reading the page)';
  return [systemPrompt, '', renderActContract(), '', 'History so far:', hist, '', 'Reply with the next single JSON object now:'].join('\n');
}

/**
 * Run one JSON action through the gate + engine, returning the tool_result text.
 * Exposed so the paired loop drives the identical path as the BYOK executors.
 */
export async function runActByName(
  ctx: ActContext,
  name: string,
  args: Record<string, unknown>,
  snapshotIdRef: { id: string },
): Promise<{ ok: boolean; resultText: string }> {
  const raw = toVerbInput(name, args, snapshotIdRef.id);
  const verb = validateBrowserVerb(raw);
  if (!verb) return { ok: false, resultText: `invalid ${name} arguments` };
  if (name !== 'read_page' && name !== 'navigate' && !snapshotIdRef.id && rawUsesRef(raw))
    return { ok: false, resultText: 'read_page first to get element refs' };
  return runVerb(ctx, verb, snapshotIdRef);
}
