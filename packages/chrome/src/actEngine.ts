// The CDP action engine: turns a validated BrowserVerb into real, trusted input
// on a tab. Impure orchestration only — the arithmetic/lookup lives in
// actPlan.ts, the injected page programs in snapshotScript.ts / cursorScript.ts,
// and the raw debugger calls in cdp.ts. Every interact verb draws the shared
// virtual cursor at its target BEFORE dispatching, so nothing the agent does to
// a page happens invisibly.
//
// No module-level mutable state (MV3): the ref→element map lives in the PAGE
// (globalThis.__nffEls, keyed by snapshot id) — see snapshotScript.ts — so a
// worker death between read_page and an action is caught as a stale ref, never
// a wrong click.

import type { BrowserVerb, Target } from '@nff-brain/core/browserVerbs';
import type { PageSnapshot } from '@nff-brain/core/pageSnapshot';
import { isRestrictedUrl } from './actGate.js';
import { buildCursorInstallerSource, CURSOR_GLOBAL } from './cursorScript.js';
import { ATTENTION_GLOBAL, buildAttentionInstallerSource } from './attentionScript.js';
import { buildFingerprintSource, buildResolveSource, buildSnapshotSource, refIndex } from './snapshotScript.js';
import { dragSamples, keyDescriptor, modifierBits } from './actPlan.js';
import { detach, ensureAttached, evaluate, send } from './cdp.js';

export interface VerbResult {
  ok: boolean;
  resultText: string;
  /** page.read returns the fresh snapshot so the caller can persist its refMap. */
  snapshot?: PageSnapshot;
  /** Set when the verb changed which tab is being driven (tab.switch, tab.open{active}, tab.duplicate) — the caller rebinds ActContext.tabId to this. */
  newTabId?: number;
}

type Point = {
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** tag + short accessible name, e.g. `button "Get started"` — for transcript/prompt text, not the walker's full name algorithm. */
  label?: string;
  /** True when something else sits on top of the element's center point (a cookie banner, a modal) — a click here would land on THAT, not the element. */
  occluded?: boolean;
  /** Short tag+id/class description of the occluding element, when occluded. */
  occluder?: string;
};
type ResolveOutcome = { ok: true; point: Point } | { ok: false; error: string };

/**
 * A hung page (most commonly a native JS dialog — alert/confirm/prompt —
 * blocking the renderer's main thread) makes `chrome.debugger.sendCommand`
 * (what evaluate() is built on) hang indefinitely rather than reject, since
 * Runtime.evaluate needs the main thread to run. `evaluate(...).catch(...)`
 * alone does NOT protect against this — a promise that never settles never
 * reaches its .catch either. Used only for the attention overlay's show/hide/
 * consumeStop and the cursor's hide, because those specifically sit on paths
 * that MUST stay reliable regardless of page state: attentionConsumeStop is
 * the first thing actRun.ts's keepGoing() awaits every turn, so without this
 * a wedged page would silently defeat the Stop button (which used to be pure
 * chrome.storage and therefore page-state-independent) — not just delay the
 * overlay's own visuals. The existing cursor install/move/press/drag calls
 * are deliberately left unguarded: a hang there only stalls the one click
 * about to happen, not Stop/Clear/run-start.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
const ATTENTION_CALL_TIMEOUT_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** How long a click gets to visibly affect the page before pointer.click reports it as a probable no-op. */
const CLICK_VERIFY_DELAY_MS = 250;

async function resolveTarget(tabId: number, target: Target): Promise<ResolveOutcome> {
  if ('x' in target) return { ok: true, point: { x: target.x, y: target.y } };
  const idx = refIndex(target.ref);
  if (idx === null) return { ok: false, error: `bad ref "${target.ref}"` };
  const r = await evaluate<{
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    label?: string;
    occluded?: boolean;
    occluder?: string;
    stale?: boolean;
    gone?: boolean;
  }>(tabId, buildResolveSource(target.snapshotId, idx));
  if (!r || r.stale) return { ok: false, error: 'stale ref — the page changed, call read_page again' };
  if (r.gone) return { ok: false, error: 'that element is no longer on the page — call read_page again' };
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { ok: false, error: 'could not locate that element' };
  return { ok: true, point: { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label, occluded: r.occluded, occluder: r.occluder } };
}

/** Cheap page fingerprint (URL + title + visible-text length), or '' on failure — used only for a soft did-anything-change hint after a click. */
async function fingerprint(tabId: number): Promise<string> {
  return (await evaluate<string>(tabId, buildFingerprintSource()).catch(() => '')) || '';
}

// ── cursor visualization ─────────────────────────────────────────────────────

async function cursorInstall(tabId: number): Promise<void> {
  await evaluate(tabId, buildCursorInstallerSource()).catch(() => undefined);
}
/**
 * Show the cursor pulsing at its idle corner anchor — called once at run
 * start (src/actRun.ts's drive()) so the agent reads as alive during the
 * page.read/LLM-reasoning stretch before its first real pointer action,
 * instead of the page showing nothing at all until the first click.
 */
export async function cursorShowIdle(tabId: number): Promise<void> {
  await cursorInstall(tabId);
  await evaluate(tabId, `globalThis.${CURSOR_GLOBAL} && globalThis.${CURSOR_GLOBAL}.showIdle()`).catch(() => undefined);
}
async function cursorMove(tabId: number, x: number, y: number): Promise<void> {
  await evaluate(tabId, `globalThis.${CURSOR_GLOBAL} && globalThis.${CURSOR_GLOBAL}.moveTo(${x},${y})`, {
    awaitPromise: true,
  }).catch(() => undefined);
}
async function cursorPress(tabId: number): Promise<void> {
  await evaluate(tabId, `globalThis.${CURSOR_GLOBAL} && globalThis.${CURSOR_GLOBAL}.press()`, {
    awaitPromise: true,
  }).catch(() => undefined);
}
async function cursorDrag(tabId: number, points: Point[]): Promise<void> {
  await evaluate(tabId, `globalThis.${CURSOR_GLOBAL} && globalThis.${CURSOR_GLOBAL}.dragPath(${JSON.stringify(points)})`, {
    awaitPromise: true,
  }).catch(() => undefined);
}
/** Fade the cursor overlay out — exported so actRun.ts can clean up at every stop point. */
export async function cursorHide(tabId: number): Promise<void> {
  await withTimeout(
    evaluate(tabId, `globalThis.${CURSOR_GLOBAL} && globalThis.${CURSOR_GLOBAL}.hide()`).catch(() => undefined),
    ATTENTION_CALL_TIMEOUT_MS,
    undefined,
  );
}

// ── attention overlay (glow border + Stop pill) ─────────────────────────────
// Exported for src/actRun.ts: shown once at run start, reinstalled alongside
// the cursor before every interact verb (so it survives a navigation the same
// way the cursor already does), and polled for a Stop-button click at the same
// between-turns checkpoint that already honors the panel's Stop button.

/** Install (idempotent) and fade in the glow border + Stop pill. */
export async function attentionShow(tabId: number): Promise<void> {
  await withTimeout(evaluate(tabId, buildAttentionInstallerSource()).catch(() => undefined), ATTENTION_CALL_TIMEOUT_MS, undefined);
  await withTimeout(
    evaluate(tabId, `globalThis.${ATTENTION_GLOBAL} && globalThis.${ATTENTION_GLOBAL}.show()`).catch(() => undefined),
    ATTENTION_CALL_TIMEOUT_MS,
    undefined,
  );
}
/** Fade the glow border + Stop pill out. Safe even if never shown. */
export async function attentionHide(tabId: number): Promise<void> {
  await withTimeout(
    evaluate(tabId, `globalThis.${ATTENTION_GLOBAL} && globalThis.${ATTENTION_GLOBAL}.hide()`).catch(() => undefined),
    ATTENTION_CALL_TIMEOUT_MS,
    undefined,
  );
}
/**
 * Read and clear the page's Stop-button flag. False (never true, and never
 * hangs) if the overlay isn't installed, the tab has no attached debugger, or
 * the page's renderer is blocked — the panel's own storage-based Stop must
 * stay reliable regardless of what this returns or how long the page takes.
 */
export async function attentionConsumeStop(tabId: number): Promise<boolean> {
  const v = await withTimeout(
    evaluate<boolean>(
      tabId,
      `globalThis.${ATTENTION_GLOBAL} ? globalThis.${ATTENTION_GLOBAL}.consumeStop() : false`,
    ).catch(() => false),
    ATTENTION_CALL_TIMEOUT_MS,
    false,
  );
  return !!v;
}

// ── raw input ────────────────────────────────────────────────────────────────

async function mouse(tabId: number, type: string, p: Point, extra: Record<string, unknown> = {}): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
}

async function pressKey(tabId: number, key: string, modifiers: number): Promise<VerbResult> {
  const d = keyDescriptor(key);
  if (!d) return { ok: false, resultText: `unknown key "${key}"` };
  const base = { modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
  await send(tabId, 'Input.dispatchKeyEvent', { type: d.text ? 'keyDown' : 'rawKeyDown', ...base, ...(d.text ? { text: d.text } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return { ok: true, resultText: `pressed ${key}` };
}

// ── snapshot ─────────────────────────────────────────────────────────────────

/**
 * Snapshot ids are minted with crypto.randomUUID (no module-level counter, so
 * no MV3 worker-death state): the id must be unique across navigations AND
 * worker lifetimes, or a stale ref could false-match a reused "s1" after a page
 * reload reset the page-side counter. A random token per read closes that hole.
 */
export async function takeSnapshot(tabId: number, mode: 'interactive' | 'text'): Promise<PageSnapshot> {
  const snapshotId = 's_' + crypto.randomUUID().slice(0, 8);
  const snap = await evaluate<Omit<PageSnapshot, 'tabId'>>(tabId, buildSnapshotSource(snapshotId, mode));
  return { ...snap, tabId } as PageSnapshot;
}

// ── tabs ─────────────────────────────────────────────────────────────────────

/**
 * Make `newTabId` the active, driven tab: detach the debugger from `oldTabId`
 * (if different) and attach it to `newTabId`, reporting the rebind so the
 * caller updates ActContext.tabId. Refuses restricted pages the same way
 * startActionRun does, so a bad target fails with a clear message rather than
 * an opaque CDP reject.
 */
async function switchTo(oldTabId: number, newTabId: number): Promise<VerbResult> {
  let target: chrome.tabs.Tab;
  try {
    target = await chrome.tabs.get(newTabId);
  } catch {
    return { ok: false, resultText: `tab ${newTabId} is no longer open` };
  }
  if (isRestrictedUrl(target.url)) return { ok: false, resultText: `cannot drive tab ${newTabId} — browser-internal or restricted page` };
  await chrome.tabs.update(newTabId, { active: true });
  if (newTabId !== oldTabId) await detach(oldTabId);
  try {
    await ensureAttached(newTabId);
  } catch (err) {
    return { ok: false, resultText: err instanceof Error ? `could not attach to tab ${newTabId} (${err.message})` : `could not attach to tab ${newTabId}` };
  }
  return { ok: true, resultText: `switched to tab ${newTabId} (${target.title || target.url || 'untitled'})`, newTabId };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export async function executeVerb(tabId: number, verb: BrowserVerb): Promise<VerbResult> {
  switch (verb.kind) {
    case 'page.read': {
      const snap = await takeSnapshot(tabId, verb.mode ?? 'interactive');
      return { ok: true, resultText: `read ${snap.elements.length} interactive elements`, snapshot: snap };
    }
    case 'pointer.move':
    case 'touch.tap': {
      const r = await resolveTarget(tabId, verb.target);
      if (!r.ok) return { ok: false, resultText: r.error };
      await cursorInstall(tabId);
      await attentionShow(tabId);
      await cursorMove(tabId, r.point.x, r.point.y);
      await mouse(tabId, 'mouseMoved', r.point);
      const on = r.point.label ? ` on ${r.point.label}` : '';
      return { ok: true, resultText: `moved to ${Math.round(r.point.x)},${Math.round(r.point.y)}${on}` };
    }
    case 'pointer.click': {
      const r = await resolveTarget(tabId, verb.target);
      if (!r.ok) return { ok: false, resultText: r.error };
      if (r.point.occluded) {
        return {
          ok: false,
          resultText: `cannot click — the element is covered by <${r.point.occluder || 'another element'}>, likely a banner or modal; dismiss it, then read_page again`,
        };
      }
      const mods = modifierBits(verb.modifiers);
      const before = await fingerprint(tabId);
      await cursorInstall(tabId);
      await attentionShow(tabId);
      await cursorMove(tabId, r.point.x, r.point.y);
      await cursorPress(tabId);
      await mouse(tabId, 'mouseMoved', r.point, { modifiers: mods });
      await mouse(tabId, 'mousePressed', r.point, { button: verb.button, clickCount: verb.clickCount, modifiers: mods });
      await mouse(tabId, 'mouseReleased', r.point, { button: verb.button, clickCount: verb.clickCount, modifiers: mods });
      const on = r.point.label ? ` on ${r.point.label}` : '';
      let resultText = `${verb.button} click x${verb.clickCount}${on} at ${Math.round(r.point.x)},${Math.round(r.point.y)}`;
      if (before) {
        await sleep(CLICK_VERIFY_DELAY_MS);
        const after = await fingerprint(tabId);
        if (after && after === before) {
          resultText += ' — no visible page change detected; the button may be disabled, occluded, or need another interaction';
        }
      }
      return { ok: true, resultText };
    }
    case 'pointer.down':
    case 'pointer.up': {
      const r = await resolveTarget(tabId, verb.target);
      if (!r.ok) return { ok: false, resultText: r.error };
      await mouse(tabId, verb.kind === 'pointer.down' ? 'mousePressed' : 'mouseReleased', r.point, { button: verb.button, clickCount: 1 });
      return { ok: true, resultText: `${verb.kind === 'pointer.down' ? 'pressed' : 'released'} ${verb.button}` };
    }
    case 'pointer.drag': {
      const from = await resolveTarget(tabId, verb.from);
      if (!from.ok) return { ok: false, resultText: from.error };
      const to = await resolveTarget(tabId, verb.to);
      if (!to.ok) return { ok: false, resultText: to.error };
      const mods = modifierBits(verb.modifiers);
      const path = dragSamples(from.point, to.point, verb.steps ?? 10);
      await cursorInstall(tabId);
      await attentionShow(tabId);
      await mouse(tabId, 'mouseMoved', from.point);
      await mouse(tabId, 'mousePressed', from.point, { button: 'left', clickCount: 1, modifiers: mods });
      await cursorDrag(tabId, path);
      for (const p of path) await mouse(tabId, 'mouseMoved', p, { button: 'left', modifiers: mods });
      await mouse(tabId, 'mouseReleased', to.point, { button: 'left', clickCount: 1, modifiers: mods });
      return { ok: true, resultText: `dragged to ${Math.round(to.point.x)},${Math.round(to.point.y)}` };
    }
    case 'scroll.wheel': {
      const r = await resolveTarget(tabId, verb.target);
      if (!r.ok) return { ok: false, resultText: r.error };
      await mouse(tabId, 'mouseWheel', r.point, { deltaX: verb.dx, deltaY: verb.dy, modifiers: modifierBits(verb.modifiers) });
      const at = r.point.label ? ` at ${r.point.label}` : '';
      return { ok: true, resultText: `scrolled ${verb.dx},${verb.dy}${at}` };
    }
    case 'key.type': {
      if (verb.mode === 'keys') {
        for (const ch of verb.text) {
          const res = await pressKey(tabId, ch, 0);
          if (!res.ok) return res;
        }
        return { ok: true, resultText: `typed ${verb.text.length} chars` };
      }
      await send(tabId, 'Input.insertText', { text: verb.text });
      return { ok: true, resultText: `typed "${verb.text.slice(0, 40)}"` };
    }
    case 'key.press': {
      const mods = modifierBits(verb.modifiers);
      const count = verb.count ?? 1;
      let last: VerbResult = { ok: true, resultText: '' };
      for (let i = 0; i < count; i++) {
        last = await pressKey(tabId, verb.key, mods);
        if (!last.ok) return last;
      }
      return { ok: true, resultText: `pressed ${verb.key}${count > 1 ? ` x${count}` : ''}` };
    }
    case 'element.focus':
    case 'scroll.intoView': {
      const idx = refIndex(verb.ref);
      if (idx === null) return { ok: false, resultText: `bad ref "${verb.ref}"` };
      const method = verb.kind === 'element.focus' ? 'focus()' : 'scrollIntoView({block:"center"})';
      const r = await evaluate<{ ok?: boolean; stale?: boolean; gone?: boolean }>(
        tabId,
        `(function(){if(globalThis.__nffSnap!==${JSON.stringify(verb.snapshotId)})return{stale:true};` +
          `var el=(globalThis.__nffEls||[])[${idx}];if(!el||!el.isConnected)return{gone:true};el.${method};return{ok:true};})()`,
      );
      if (!r || r.stale) return { ok: false, resultText: 'stale ref — call read_page again' };
      if (r.gone) return { ok: false, resultText: 'that element is no longer on the page' };
      return { ok: true, resultText: verb.kind === 'element.focus' ? 'focused' : 'scrolled into view' };
    }
    case 'nav.goto': {
      await chrome.tabs.update(tabId, { url: verb.url });
      return { ok: true, resultText: `navigating to ${verb.url}` };
    }
    case 'nav.reload': {
      await send(tabId, 'Page.reload', { ignoreCache: !!verb.hard });
      return { ok: true, resultText: verb.hard ? 'hard reloaded' : 'reloaded' };
    }
    case 'nav.back': {
      await chrome.tabs.goBack(tabId);
      return { ok: true, resultText: 'went back' };
    }
    case 'nav.forward': {
      await chrome.tabs.goForward(tabId);
      return { ok: true, resultText: 'went forward' };
    }
    case 'page.zoom': {
      await chrome.tabs.setZoom(tabId, verb.factor);
      return { ok: true, resultText: `zoom ${verb.factor}` };
    }
    case 'tab.list': {
      const tabs = await chrome.tabs.query({});
      const lines = tabs.map((t) => `[${t.id}]${t.active ? ' (active)' : ''} ${t.title || ''} — ${t.url || ''}`);
      return { ok: true, resultText: `${tabs.length} tab${tabs.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
    }
    case 'tab.switch':
      return switchTo(tabId, verb.tabId);
    case 'tab.open': {
      const active = verb.active ?? true;
      const created = await chrome.tabs.create({ url: verb.url, active });
      if (created.id === undefined) return { ok: false, resultText: 'could not open the tab' };
      if (!active) return { ok: true, resultText: `opened tab ${created.id} (background)` };
      return switchTo(tabId, created.id);
    }
    case 'tab.duplicate': {
      const dup = await chrome.tabs.duplicate(verb.tabId);
      if (!dup || dup.id === undefined) return { ok: false, resultText: 'could not duplicate that tab' };
      return switchTo(tabId, dup.id);
    }
    case 'tab.close': {
      await chrome.tabs.remove(verb.tabId);
      return { ok: true, resultText: `closed tab ${verb.tabId}` };
    }
    default:
      // Verbs slated for later milestones (forms, dialogs, screenshots,
      // touch.swipe, waitFor, find, upload). Validated but not yet dispatched.
      return { ok: false, resultText: `"${verb.kind}" is recognized but not enabled yet` };
  }
}
