// The act-benchmark scenario spec — the primitives ladder for the CDP act
// agent. Parallel to (not replacing) src/scenario.ts: that one is typed
// against the legacy LinkedIn WebAgentRun; this one is typed against the act
// engine's run view and the fixture-server oracle. Shares capabilities.json,
// the scorecard, and the id grammar.
//
// Layer A (L1) = engine conformance: scripted verb sequences through the bench
// driver, no LLM, deterministic. Layer B (L2) = agent capability: a real
// `claude -p` run against a goal, verified by the same fixture ledger.

import { isValidScenarioId } from '../scenario.js';
import type { DriverClient } from '../harness/driver.js';
import type { FixtureHandle } from '../harness/fixtures.js';
import type { ActRunView } from '@nff-brain/core/benchProtocol';

export type ActCapability =
  | 'ACT-harness' // fixture server + bench driver + launcher
  | 'ACT-engine' // today's implemented verb set
  | 'ACT-engine2' // input fidelity: real modifier key sequencing, event-count dblclick, paced drags, HTML5 DnD synthesis
  | 'ACT-forms' // form.setValue + native <select> support
  | 'ACT-upload' // form.upload (DOM.setFileInputFiles + file delivery)
  | 'ACT-dialogs' // dialog.handle + Page.javascriptDialogOpening
  | 'ACT-clipboard' // clipboard verbs + permissions
  | 'ACT-downloads' // downloads permission + result channel
  | 'ACT-touch' // touch.tap / touch.swipe as real touch events
  | 'ACT-observe-extras'; // page.find, page.screenshot, nav.waitFor

export type PrimitiveFamily =
  | 'pointer'
  | 'drag'
  | 'scroll'
  | 'keys'
  | 'edit'
  | 'forms'
  | 'nav'
  | 'tabs'
  | 'dialogs'
  | 'media'
  | 'content'
  | 'touch'
  | 'oos';

export interface Verdict {
  pass: boolean;
  detail: string;
}

export interface BenchCtx {
  driver: DriverClient;
  fixtures: FixtureHandle;
  /** The tab the runner opened on this case's fixture page, already attached. */
  tabId: number;
  /** The ?run= nonce scoping this case's ledger entries. */
  nonce: string;
  /** Absolute fixture URL carrying the nonce, e.g. pageUrl('pointer.html'). */
  pageUrl(page: string, params?: Record<string, string>): string;
}

interface ActCaseBase {
  /** '<category>.<name>.L<level>' — primitives.<name>.L1|L2, stable forever. */
  id: string;
  family: PrimitiveFamily;
  title: string;
  requires: ActCapability[];
  /**
   * Registered but NEVER executed — structurally impossible for a Chrome
   * extension agent (OS dialogs, CAPTCHA, incognito, browser UI). The text
   * says why; the scorecard row is 'out-of-scope'.
   */
  outOfScope?: string;
}

/** Layer A — deterministic engine conformance (id level L1). */
export interface ActConformanceCase extends ActCaseBase {
  /** Fixture page basename the runner opens for this case. */
  page: string;
  /**
   * Present = this case documents a KNOWN engine gap: it runs, and a failing
   * verdict reports outcome 'known-gap' (with this text) rather than 'fail'.
   * A PASSING verdict fails the run instead — a stale marker must be removed
   * in the same change that fixes the engine.
   */
  knownGap?: string;
  run?(ctx: BenchCtx): Promise<Verdict>;
}

/** Layer B — real-LLM agent capability (id level L2). */
export interface ActAgentScenario extends ActCaseBase {
  page: string;
  /** '{base}' → fixture base URL, '{nonce}' → the run nonce, before submit. */
  goal: string;
  maxActions: number;
  reps: number;
  /** e.g. 2 reps, passRate 0.5 ⇒ 1/2 must pass. */
  passRate: number;
  timeoutMs?: number;
  verify?(ctx: BenchCtx, run: ActRunView): Promise<Verdict>;
}

export type AnyActCase = ActConformanceCase | ActAgentScenario;

export function isAgentScenario(c: AnyActCase): c is ActAgentScenario {
  return 'goal' in c;
}

export interface Capabilities {
  live: string[];
}

export function missingActCapabilities(c: AnyActCase, caps: Capabilities): ActCapability[] {
  const live = new Set(caps.live);
  return c.requires.filter((r) => !live.has(r));
}

export function defineConformance(c: ActConformanceCase): ActConformanceCase {
  if (!isValidScenarioId(c.id)) throw new Error(`bad case id: ${c.id}`);
  return c;
}

export function defineAgentScenario(c: ActAgentScenario): ActAgentScenario {
  if (!isValidScenarioId(c.id)) throw new Error(`bad scenario id: ${c.id}`);
  return c;
}
