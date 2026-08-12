// The review-triage step: a large haul is narrowed AUTOMATICALLY — one model
// call, then a silent fallback chain (corroborated → best-of-each-kind →
// everything). No menu: a menu is one more decision on top of 490. Runs
// triageItems and the pure strategy helpers directly, with a scripted fake Ui
// and an injected curator stub (no real claude call).

import { describe, expect, it } from 'vitest';
import type { PendingItem } from '@nff-brain/core';
import {
  balancedBestItems,
  buildCuratePrompt,
  corroboratedItems,
  parseCurateResponse,
  triageItems,
} from '../src/commands/importWizard.js';
import { planFromArgs } from '../src/commands/importPlan.js';
import { parseArgs } from '../src/util.js';
import { fakeUi } from './fixtures/fakeUi.js';

const KINDS = ['memory', 'decision', 'preference', 'task', 'failure'] as const;

function item(i: number, over: Partial<PendingItem> = {}): PendingItem {
  const conf = 0.3 + (i % 7) * 0.1; // spread 0.3 … 0.9
  return {
    key: `k${i}`,
    id: `node-${i}`,
    status: 'new',
    kind: i % 9 === 0 ? KINDS[1 + (i % 4)] : 'memory', // mostly memories, like real hauls
    category: 'strategy',
    title: `Item ${i}`,
    content: `Content ${i}`,
    confidence: conf,
    checked: conf >= 0.5,
    sources: i % 3 === 0 ? [{ sessionId: `a${i}` }, { sessionId: `b${i}` }] : [{ sessionId: `a${i}` }],
    hash: `h${i}`,
    ...over,
  } as PendingItem;
}

const haul = (n: number): PendingItem[] => Array.from({ length: n }, (_, i) => item(i));
const w = () => ({ plan: planFromArgs(parseArgs([])) });
const run = (items: PendingItem[], curate?: (p: string) => Promise<string>) => {
  const ui = fakeUi([]);
  return triageItems(w(), ui, items, curate).then((shown) => ({ shown, ui }));
};
const failingCurator = async (): Promise<string> => {
  throw new Error('model exploded');
};

describe('strategy helpers', () => {
  it('corroborated = 2+ sessions, never brain-duplicates', () => {
    const items = haul(100);
    const kept = corroboratedItems(items);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((i) => i.sources.length >= 2 && i.status !== 'duplicate')).toBe(true);
  });

  it('balanced takes at most 12 per kind so memories cannot drown the rest', () => {
    const items = haul(490);
    const kept = balancedBestItems(items);
    expect(kept.length).toBeLessThanOrEqual(60);
    const perKind = new Map<string, number>();
    for (const i of kept) perKind.set(i.kind, (perKind.get(i.kind) ?? 0) + 1);
    for (const n of perKind.values()) expect(n).toBeLessThanOrEqual(12);
    // The rare kinds survive: decisions/preferences are present, not buried.
    expect([...perKind.keys()].length).toBeGreaterThan(1);
  });

  it('the curate prompt lists keys and demands strict JSON', () => {
    const p = buildCuratePrompt(haul(90));
    expect(p).toContain('k1 | memory');
    expect(p).toContain('{"keep":["key","key",...]}');
  });

  it('parseCurateResponse survives prose around the JSON and unknown keys', () => {
    const items = haul(90);
    const kept = parseCurateResponse('Sure! Here you go:\n{"keep":["k1","k2","nope"]}\nDone.', items);
    expect(kept!.map((i) => i.key).sort()).toEqual(['k1', 'k2']);
    expect(parseCurateResponse('no json here', items)).toBeNull();
    expect(parseCurateResponse('{"keep":[]}', items)).toBeNull();
  });
});

describe('automatic review triage', () => {
  it('small hauls skip triage entirely — no model call, no chrome', async () => {
    const items = haul(30);
    let called = 0;
    const { shown, ui } = await run(items, async () => {
      called++;
      return '{"keep":[]}';
    });
    expect(shown).toBe(items);
    expect(called).toBe(0);
    expect(ui.asked).toEqual([]);
  });

  it('large hauls trigger ONE curator call and keep its picks — no menu', async () => {
    const items = haul(490);
    const prompts: string[] = [];
    const { shown, ui } = await run(items, async (p) => {
      prompts.push(p);
      return '{"keep":["k3","k10","k17"]}';
    });
    expect(prompts.length).toBe(1);
    expect(ui.asked).toEqual([]); // never a question
    expect(shown.map((i) => i.key).sort()).toEqual(['k10', 'k17', 'k3']);
    expect(ui.notes.join('\n')).toContain('kept 3 of 490');
    expect(ui.notes.join('\n')).toContain('nothing is lost');
  });

  it('a broken curator falls back to the corroborated items', async () => {
    const items = haul(490);
    const { shown, ui } = await run(items, failingCurator);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((i) => i.sources.length >= 2)).toBe(true);
    expect(ui.notes.join('\n')).toContain('more than one session');
  });

  it('with nothing corroborated it falls back to best of each kind', async () => {
    const items = haul(490).map((i) => ({ ...i, sources: [i.sources[0]] })); // all single-session
    const { shown, ui } = await run(items, failingCurator);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(ui.notes.join('\n')).toContain('best of each kind');
  });

  it('the last resort is everything — the review always opens', async () => {
    // Single-kind, single-session: corroborated empty AND balanced === items?
    // No — balanced trims to 12. Force the true last resort with ≤12 per kind
    // spread so balanced covers everything… simplest: all duplicates.
    const items = haul(490).map((i) => ({ ...i, status: 'duplicate' as const, sources: [i.sources[0]] }));
    const { shown } = await run(items, failingCurator);
    expect(shown.length).toBe(490); // strategies exclude duplicates → everything
  });

  it('duplicates never enter the curated or fallback slices', async () => {
    const items = haul(490).map((i, idx) =>
      idx % 2 === 0 ? { ...i, status: 'duplicate' as const, checked: false } : i,
    );
    const { shown } = await run(items, failingCurator);
    expect(shown.every((i) => i.status !== 'duplicate')).toBe(true);
  });
});
