// What did the brain actually save you? Every recall injects knowledge the
// agent would otherwise have had to rediscover — grep the repo, open files,
// re-derive the conclusion. This module estimates that avoided context cost.
//
// It is an ESTIMATE, deliberately built from data already on disk: brain.json's
// recallCount / origin / graphifyRef. Nothing new is written, no counter has to
// be maintained by the fail-open hook path, and the number is retroactive on
// brains that already exist.
//
// Like score.ts and activity.ts this module stays free of node:* imports.

import { RECALL_DEFAULTS } from './recall.js';
import type { ActivityEvent } from './activity.js';
import type { BrainNode } from './types.js';

/**
 * The whole counterfactual in one object — the assumption the displayed number
 * rests on, in one place, so it can be argued with.
 *
 * Rediscovery costs are per INJECTION, sized as "what the agent would plausibly
 * have read to answer one task", not "what the knowledge cost to learn the
 * first time". Deliberately conservative: a distilled node is roughly one grep
 * plus a hundred lines of re-reading.
 */
export const SAVINGS_MODEL = {
  charsPerToken: 4,
  /** Preamble overhead per node beyond its content: id/title/category/related line. */
  preambleOverheadTokens: 20,
  rediscoverAgentTokens: 1200, // distilled from a session: re-derive it
  rediscoverSeedTokens: 800, // curated: re-read the doc it came from
  /** Codebase-map nodes stand in for reading their underlying entities… */
  graphifyPerChildTokens: 150,
  /** …but one task would never read all 45 of them — cap the claim. */
  graphifyMaxTokens: 2500,
  /** Edge-expanded neighbours are less certainly used than lexical seeds. */
  expandedWeight: 0.6,
} as const;

export function approxTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / SAVINGS_MODEL.charsPerToken);
}

/** What including this node in a recall preamble COSTS in context. */
export function injectionTokens(node: BrainNode): number {
  const content = node.content ?? '';
  const trimmed = content.length > RECALL_DEFAULTS.maxContentChars
    ? content.slice(0, RECALL_DEFAULTS.maxContentChars)
    : content;
  return approxTokens(trimmed) + approxTokens(node.title ?? '') + SAVINGS_MODEL.preambleOverheadTokens;
}

/** What NOT having this node would have cost: the rediscovery read. */
export function rediscoveryTokens(node: BrainNode): number {
  if (node.origin === 'graphify') {
    const children = node.graphifyRef?.children?.length ?? 0;
    return Math.min(children * SAVINGS_MODEL.graphifyPerChildTokens, SAVINGS_MODEL.graphifyMaxTokens);
  }
  return node.origin === 'seed' ? SAVINGS_MODEL.rediscoverSeedTokens : SAVINGS_MODEL.rediscoverAgentTokens;
}

/** Net saving of one injection — never negative (a node can cost more than it saves). */
export function savedPerInjection(node: BrainNode): number {
  return Math.max(0, rediscoveryTokens(node) - injectionTokens(node));
}

export interface BrainSavings {
  total: number; // estimated tokens saved over the brain's lifetime
  injections: number; // how many node-injections that is spread over
  byOrigin: Record<BrainNode['origin'], number>;
}

/**
 * Lifetime savings across the merged graph. recallCount is bumped only by
 * `recall` (bumpRecall), so this counts exactly the preamble injections that
 * actually happened.
 */
export function brainSavings(nodes: readonly BrainNode[]): BrainSavings {
  const byOrigin: Record<BrainNode['origin'], number> = { seed: 0, agent: 0, graphify: 0 };
  let total = 0;
  let injections = 0;
  for (const n of nodes) {
    const count = Math.max(0, n.recallCount ?? 0);
    if (count === 0) continue;
    const saved = count * savedPerInjection(n);
    total += saved;
    injections += count;
    byOrigin[n.origin] = (byOrigin[n.origin] ?? 0) + saved;
  }
  return { total: Math.round(total), injections, byOrigin };
}

/**
 * Live delta from activity events, for a "+N this session" readout.
 *
 * Counts `recall` only — the same event that bumps recallCount — so the session
 * number is exactly the increment of the lifetime one. `prompt` and `distill`
 * inject nothing (novelty scoring / a write), and `search`/`expand` are agent
 * reads that no durable counter tracks, so they are left out rather than making
 * the two numbers disagree.
 */
export function eventSavings(
  events: readonly ActivityEvent[],
  nodeById: ReadonlyMap<string, BrainNode>,
): number {
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'recall') continue;
    const seedCount = e.seedCount ?? e.ids.length;
    e.ids.forEach((id, i) => {
      const node = nodeById.get(id);
      if (!node) return;
      const weight = i < seedCount ? 1 : SAVINGS_MODEL.expandedWeight;
      total += weight * savedPerInjection(node);
    });
  }
  return Math.round(total);
}

/** 840 · 8.4k · 412k · 1.0M — short enough for a tree item label. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = v / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}
