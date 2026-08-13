// Global, single-active-run persistence for the web agent — mirrors
// modelState.ts's tolerant-read/atomic-write pattern. Not keyed to a brain
// path: the browser has no workspace concept, so one run is global.
//
// Concurrency stance, like modelState.ts: no lock. The temp+rename write is
// atomic so no reader ever sees a torn file; a request racing a poll can lose
// one update, acceptable at this write frequency (one action per 1-4 minutes).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BRAIN_DIR } from './paths.js';
import { writeFileAtomic } from './store.js';
import {
  WEB_AGENT_HISTORY_MAX,
  WEB_AGENT_RECENT_MAX,
  type ActionRecord,
  type AgentCardResult,
  type PlanStep,
  type RunPhase,
  type WebAgentListTarget,
  type WebAgentPlan,
  type WebAgentRun,
  type WebAgentState,
} from './webAgentTypes.js';

const TERMINAL_PHASES: readonly RunPhase[] = ['stopped', 'done', 'error'];

export function webAgentStatePath(): string {
  return path.join(os.homedir(), BRAIN_DIR, 'web-agent.json');
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function emptyWebAgentState(): WebAgentState {
  return { version: 1, active: null, recent: [] };
}

export function newRunId(now = Date.now()): string {
  return `run_${now}_${randomBytes(3).toString('hex')}`;
}

function isPlanStep(v: unknown): v is PlanStep {
  const s = v as Partial<PlanStep>;
  return (
    !!s &&
    typeof s.id === 'string' &&
    typeof s.summary === 'string' &&
    (s.verb === 'searchPeople' || s.verb === 'evaluateCards') &&
    !!s.args &&
    typeof s.args === 'object'
  );
}

function isPlan(v: unknown): v is WebAgentPlan {
  const p = v as Partial<WebAgentPlan>;
  return (
    !!p &&
    typeof p.goal === 'string' &&
    p.site === 'linkedin' &&
    typeof p.criteria === 'string' &&
    Array.isArray(p.steps) &&
    p.steps.every(isPlanStep) &&
    typeof p.maxActions === 'number' &&
    typeof p.createdAt === 'string'
  );
}

function isListTarget(v: unknown): v is WebAgentListTarget {
  const t = v as Partial<WebAgentListTarget>;
  return (
    !!t &&
    typeof t.server === 'string' &&
    typeof t.tool === 'string' &&
    !!t.toolDef &&
    typeof t.toolDef === 'object' &&
    typeof t.toolDef.name === 'string'
  );
}

function isActionRecord(v: unknown): v is ActionRecord {
  const a = v as Partial<ActionRecord>;
  return (
    !!a &&
    typeof a.stepId === 'string' &&
    (a.verb === 'navigate' || a.verb === 'readResultCards' || a.verb === 'clickConnect') &&
    !!a.args &&
    typeof a.requestedAt === 'string'
  );
}

function isCardResult(v: unknown): v is AgentCardResult {
  const c = v as Partial<AgentCardResult>;
  return !!c && typeof c.cardIndex === 'number' && typeof c.name === 'string' && typeof c.headline === 'string';
}

const RUN_PHASES: readonly RunPhase[] = ['planning', 'awaiting_approval', 'running', 'stopping', 'stopped', 'done', 'error'];

function isRun(v: unknown): v is WebAgentRun {
  const r = v as Partial<WebAgentRun>;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.phase === 'string' &&
    RUN_PHASES.includes(r.phase as RunPhase) &&
    typeof r.clientId === 'string' &&
    typeof r.goal === 'string' &&
    (r.plan === null || isPlan(r.plan)) &&
    (r.listTarget === null || r.listTarget === undefined || isListTarget(r.listTarget)) &&
    typeof r.cursor === 'number' &&
    typeof r.actionsTaken === 'number' &&
    typeof r.maxActions === 'number' &&
    typeof r.nextAllowedAtMs === 'number' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string' &&
    Array.isArray(r.history)
  );
}

function cleanRun(r: WebAgentRun): WebAgentRun {
  const pendingConnects = Array.isArray(r.pendingConnects) ? r.pendingConnects.filter(isCardResult) : [];
  return {
    ...r,
    autoApprove: r.autoApprove === true,
    listTarget: r.listTarget ?? null,
    pendingConnects,
    pendingConnectsStepId: pendingConnects.length > 0 && typeof r.pendingConnectsStepId === 'string' ? r.pendingConnectsStepId : null,
    history: r.history.filter(isActionRecord),
  };
}

/** Absent, unreadable or malformed all read as "no active run" — never throws. */
export function readWebAgentState(file = webAgentStatePath()): WebAgentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WebAgentState>;
    if (!parsed || typeof parsed !== 'object') return emptyWebAgentState();
    const active = isRun(parsed.active) ? cleanRun(parsed.active) : null;
    const recent = Array.isArray(parsed.recent) ? parsed.recent.filter(isRun).map(cleanRun) : [];
    return { version: 1, active, recent: recent.slice(0, WEB_AGENT_RECENT_MAX) };
  } catch {
    return emptyWebAgentState();
  }
}

export function writeWebAgentState(state: WebAgentState, file = webAgentStatePath()): void {
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Move the active run into recent history (most-recent-first, capped) and
 * clear it. Callers do this once a run reaches a terminal phase.
 */
export function archiveActiveRun(state: WebAgentState): WebAgentState {
  if (!state.active) return state;
  const recent = [state.active, ...state.recent].slice(0, WEB_AGENT_RECENT_MAX);
  return { version: 1, active: null, recent };
}

export function appendActionRecord(run: WebAgentRun, record: ActionRecord): WebAgentRun {
  const history = [...run.history, record].slice(-WEB_AGENT_HISTORY_MAX);
  return { ...run, history };
}

/**
 * Read-modify-write the active run if its id still matches (it may have been
 * stopped or superseded between a caller reading it and finishing async work
 * — a stale write is silently dropped rather than resurrecting a dead run).
 * Auto-archives into `recent` the moment fn's result reaches a terminal phase.
 */
export function updateActiveRun(
  runId: string,
  fn: (run: WebAgentRun) => WebAgentRun,
  file = webAgentStatePath(),
): WebAgentRun | null {
  const state = readWebAgentState(file);
  if (!state.active || state.active.id !== runId) return null;
  const updated = fn(state.active);
  let next: WebAgentState = { ...state, active: updated };
  if (isTerminalPhase(updated.phase)) next = archiveActiveRun(next);
  writeWebAgentState(next, file);
  return updated;
}

/** The cap + pacing choke point — mirrors gate.ts's shouldCapture() role. */
export function shouldGrantAction(run: WebAgentRun, nowMs: number): boolean {
  return run.phase === 'running' && run.actionsTaken < run.maxActions && nowMs >= run.nextAllowedAtMs;
}

/**
 * 1-4 minutes uniform jitter after every action result. The floor is not
 * arbitrary: chrome.alarms clamps one-shot delays to a 1-minute minimum in
 * packaged extensions, so the SW physically cannot poll faster regardless of
 * what the server would otherwise allow.
 */
export function computeNextAllowedAtMs(nowMs: number, rand: () => number = Math.random): number {
  return nowMs + 60_000 + Math.floor(rand() * 180_000);
}
