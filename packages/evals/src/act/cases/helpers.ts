// Shared assertions/plumbing for act-benchmark cases. Cases talk to the page
// ONLY through (a) driver verbs and (b) the fixture ledger — never by
// evaluating JS on the page.

import type { BenchCtx, Verdict } from '../actScenario.js';
import type { BenchPageEvent } from '@nff-brain/core/benchProtocol';

export const pass = (detail: string): Verdict => ({ pass: true, detail });
export const fail = (detail: string): Verdict => ({ pass: false, detail });

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The page ships state every 200ms — wait one beat past `settleMs`, then read
 * the freshest state() summary for this case's page.
 */
export async function settledState(ctx: BenchCtx, page: string, settleMs = 500): Promise<Record<string, unknown>> {
  await sleep(settleMs);
  const s = ctx.fixtures.ledger.lastState(ctx.nonce, page);
  if (!s) throw new Error(`no state report from ${page} for nonce ${ctx.nonce} — did the page load with ?run=?`);
  return s;
}

export function events(ctx: BenchCtx, page?: string): BenchPageEvent[] {
  return ctx.fixtures.ledger.eventsFor(ctx.nonce, page);
}

export function eventsOf(ctx: BenchCtx, page: string, type: string, target?: string): BenchPageEvent[] {
  return events(ctx, page).filter((e) => e.type === type && (target === undefined || e.target === target));
}

export function waitForEvent(
  ctx: BenchCtx,
  pred: (e: BenchPageEvent) => boolean,
  timeoutMs = 5_000,
): Promise<BenchPageEvent> {
  return ctx.fixtures.ledger.waitForEvent(ctx.nonce, pred, timeoutMs);
}

/** Click a target found by accessible-name substring; returns engine text. */
export async function clickByName(
  ctx: BenchCtx,
  nameSub: string,
  opts: { button?: 'left' | 'right' | 'middle'; clickCount?: 1 | 2 | 3; modifiers?: Record<string, boolean>; role?: string } = {},
): Promise<string> {
  const snap = await ctx.driver.read(ctx.tabId);
  const target = ctx.driver.findRef(snap, nameSub, opts.role);
  const r = await ctx.driver.mustVerb(ctx.tabId, {
    kind: 'pointer.click',
    target,
    button: opts.button ?? 'left',
    clickCount: opts.clickCount ?? 1,
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
  });
  return r.resultText;
}

/** Center of a snapshot element's rect, for coordinate-addressed verbs. */
export async function centerOf(ctx: BenchCtx, nameSub: string, role?: string): Promise<{ x: number; y: number }> {
  const snap = await ctx.driver.read(ctx.tabId);
  const needle = nameSub.toLowerCase();
  const el = snap.elements.find((e) => (role === undefined || e.role === role) && (e.name ?? '').toLowerCase().includes(needle));
  if (!el) throw new Error(`no element matching "${nameSub}" for centerOf`);
  return { x: Math.round(el.rect.x + el.rect.w / 2), y: Math.round(el.rect.y + el.rect.h / 2) };
}

export interface BenchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Viewport rect of a data-bench element, from the page's own state report —
 * the way to target non-interactive elements (div/li/p), which the engine's
 * snapshot (interactive selector) never contains.
 */
export async function rectOf(ctx: BenchCtx, page: string, benchName: string): Promise<BenchRect> {
  const s = await settledState(ctx, page, 300);
  const rects = s.rects as Record<string, BenchRect> | undefined;
  const r = rects?.[benchName];
  if (!r) throw new Error(`no rect for data-bench="${benchName}" in ${page} state (have: ${Object.keys(rects ?? {}).join(', ')})`);
  return r;
}

export function rectCenter(r: BenchRect): { x: number; y: number } {
  return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
}

/** Coordinate click (for elements outside the engine snapshot). */
export async function clickAt(
  ctx: BenchCtx,
  point: { x: number; y: number },
  opts: { button?: 'left' | 'right' | 'middle'; clickCount?: 1 | 2 | 3; modifiers?: Record<string, boolean> } = {},
): Promise<string> {
  const r = await ctx.driver.mustVerb(ctx.tabId, {
    kind: 'pointer.click',
    target: point,
    button: opts.button ?? 'left',
    clickCount: opts.clickCount ?? 1,
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
  });
  return r.resultText;
}

/** Focus an element by name, then press a key sequence. */
export async function focusByName(ctx: BenchCtx, nameSub: string, role?: string): Promise<void> {
  const snap = await ctx.driver.read(ctx.tabId);
  const t = ctx.driver.findRef(snap, nameSub, role);
  await ctx.driver.mustVerb(ctx.tabId, { kind: 'element.focus', ref: t.ref, snapshotId: t.snapshotId });
}

export async function press(
  ctx: BenchCtx,
  key: string,
  opts: { modifiers?: Record<string, boolean>; count?: number } = {},
): Promise<void> {
  await ctx.driver.mustVerb(ctx.tabId, {
    kind: 'key.press',
    key,
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.count !== undefined ? { count: opts.count } : {}),
  });
}
