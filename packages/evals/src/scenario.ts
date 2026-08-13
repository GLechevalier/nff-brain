// The scenario spec — the whole eval suite is data conforming to this shape.
// Scenarios for EVERY use-case level are registered up front; ones whose
// capabilities haven't landed carry `requires` tags missing from
// capabilities.json and report as `blocked`, never as failures. Flipping a tag
// in capabilities.json is what turns a ladder level live (eval-driven
// development — the tests exist before the capability).

import type { WebAgentRun } from '@nff-brain/core';
import type { Oracles } from './oracles/types.js';

export type Category = 'email' | 'calendar' | 'slack' | 'linkedin' | 'crm' | 'recruiting' | 'drive';

export type SiteId = 'linkedin' | 'gmail' | 'gcal' | 'gdrive' | 'slack' | 'notion' | 'nffcrm';

/**
 * Capability tags — each maps to a roadmap phase in the plan. `P3-adapter:*`
 * is per-site. Keep this union in sync with capabilities.json's comment.
 */
export type Capability =
  | 'baseline'
  | 'P0-harness'
  | 'P1-engine'
  | 'P2-loop'
  | `P3-adapter:${SiteId}`
  | 'P4-confirm'
  | 'P4-downloads'
  | 'P5-crosssite';

export interface Verdict {
  pass: boolean;
  detail: string;
  /** Paths under the run's artifact dir (screenshots etc.). */
  artifacts?: string[];
}

export interface Scenario<Seed = unknown> {
  /** '<category>.<name>.L<level>' — stable forever; scorecards diff on it. */
  id: string;
  category: Category;
  level: number;
  title: string;
  requires: Capability[];
  sites: SiteId[];
  /** Submitted verbatim via /v1/admin/agent/goal; '{nonce}' is interpolated. */
  goal: string;
  /** plan-approve: the runner fetches the plan, asserts it, then approves. */
  mode: 'auto' | 'plan-approve';
  maxActions: number;
  /** Wall clock incl. pacing. Default: maxActions*90s + 120s (see runner). */
  timeoutMs?: number;
  /** Repetitions per eval run (LLM tier); pass iff passRate is met. */
  reps: number;
  /** 0.66 ⇒ 2/3 reps must pass. */
  passRate: number;
  seed(o: Oracles, nonce: string): Promise<Seed>;
  verify(o: Oracles, run: WebAgentRun, seed: Seed): Promise<Verdict>;
  /** Independent of verify: caps respected, nothing sent/deleted, approvals asked. */
  safety?(run: WebAgentRun, o: Oracles, seed: Seed): Promise<Verdict>;
  /** ALWAYS runs, even when seed/verify threw. */
  cleanup(o: Oracles, seed: Seed): Promise<void>;
  /** Decrements state/budgets.json for the site; runner skips when exhausted. */
  budget?: { site: SiteId; costUnits: number };
  /** Adds a needs-review scorecard row + screenshot artifacts. */
  humanReview?: boolean;
}

export type AnyScenario = Scenario<any>;

/** Identity helper — gives scenario modules inference without `satisfies` noise. */
export function defineScenario<Seed>(s: Scenario<Seed>): AnyScenario {
  return s as AnyScenario;
}

const ID_RE = /^[a-z]+(?:-[a-z]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.L\d+$/;

export function isValidScenarioId(id: string): boolean {
  return ID_RE.test(id);
}

export interface Capabilities {
  live: string[];
}

export function missingCapabilities(s: AnyScenario, caps: Capabilities): Capability[] {
  const live = new Set(caps.live);
  return s.requires.filter((r) => !live.has(r));
}
