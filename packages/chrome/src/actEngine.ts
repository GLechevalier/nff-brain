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
import { buildCursorInstallerSource, CURSOR_GLOBAL } from './cursorScript.js';
import { buildResolveSource, buildSnapshotSource, refIndex } from './snapshotScript.js';
import { dragSamples, keyDescriptor, modifierBits } from './actPlan.js';
import { evaluate, send } from './cdp.js';

export interface VerbResult {
  ok: boolean;
  resultText: string;
  /** page.read returns the fresh snapshot so the caller can persist its refMap. */
  snapshot?: PageSnapshot;
}

type Point = { x: number; y: number; w?: number; h?: number };
type ResolveOutcome = { ok: true; point: Point } | { ok: false; error: string };

async function resolveTarget(tabId: number, target: Target): Promise<ResolveOutcome> {
  if ('x' in target) return { ok: true, point: { x: target.x, y: target.y } };
  const idx = refIndex(target.ref);
  if (idx === null) return { ok: false, error: `bad ref "${target.ref}"` };
  const r = await evaluate<{ x?: number; y?: number; w?: number; h?: number; stale?: boolean; gone?: boolean }>(
    tabId,
    buildResolveSource(target.snapshotId, idx),
  );
  if (!r || r.stale) return { ok: false, error: 'stale ref — the page changed, call read_page again' };
  if (r.gone) return { ok: false, error: 'that element is no longer on the page — call read_page again' };
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { ok: false, error: 'could not locate that element' };
  return { ok: true, point: { x: r.x, y: r.y, w: r.w, h: r.h } };
}

// ── cursor visualization ─────────────────────────────────────────────────────

async function cursorInstall(tabId: number): Promise<void> {
  await evaluate(tabId, buildCursorInstallerSource()).catch(() => undefined);
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
      await cursorMove(tabId, r.point.x, r.point.y);
      await mouse(tabId, 'mouseMoved', r.point);
      return { ok: true, resultText: `moved to ${Math.round(r.point.x)},${Math.round(r.point.y)}` };
    }
    case 'pointer.click': {
      const r = await resolveTarget(tabId, verb.target);
      if (!r.ok) return { ok: false, resultText: r.error };
      const mods = modifierBits(verb.modifiers);
      await cursorInstall(tabId);
      await cursorMove(tabId, r.point.x, r.point.y);
      await cursorPress(tabId);
      await mouse(tabId, 'mouseMoved', r.point, { modifiers: mods });
      await mouse(tabId, 'mousePressed', r.point, { button: verb.button, clickCount: verb.clickCount, modifiers: mods });
      await mouse(tabId, 'mouseReleased', r.point, { button: verb.button, clickCount: verb.clickCount, modifiers: mods });
      return { ok: true, resultText: `${verb.button} click x${verb.clickCount} at ${Math.round(r.point.x)},${Math.round(r.point.y)}` };
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
      return { ok: true, resultText: `scrolled ${verb.dx},${verb.dy}` };
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
    default:
      // Verbs slated for later milestones (forms, tabs, dialogs, screenshots,
      // touch.swipe, waitFor, find, upload). Validated but not yet dispatched.
      return { ok: false, resultText: `"${verb.kind}" is recognized but not enabled yet` };
  }
}
