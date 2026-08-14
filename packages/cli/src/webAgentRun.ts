// Web agent orchestration — the one place an OneShot (today: makeOneShot()'s
// local `claude -p`) is actually invoked. Everything else (webAgentPlan.ts,
// webAgentFilter.ts, webAgentListWrite.ts) is pure prompt/parse in
// packages/core; this file is the async glue plus the two touches of the
// outside world an approved run makes: the planning/filter LLM calls, and
// the "add to list" MCP tool call.
//
// Interim by design: v1 binds `brain` to a local `claude -p` subprocess, same
// as distill/merge. Every call site takes `brain: OneShot` as a parameter
// rather than reaching for runClaude() directly, so swapping the planning
// brain for a future web-hosted equivalent means rebinding this one
// parameter, not touching the prompt/parse logic in packages/core.

import {
  appendActionRecord,
  buildFilterPrompt,
  buildPlanPrompt,
  buildToolArgsPrompt,
  callMcpTool,
  clampMaxActions,
  computeNextAllowedAtMs,
  decideNextAction,
  makeOneShot,
  newRunId,
  parseFilterResponse,
  parsePlanResponse,
  parseToolArgsResponse,
  readWebAgentState,
  shouldGrantAction,
  updateActiveRun,
  writeWebAgentState,
  type ActionRecord,
  type AgentCardResult,
  type McpServerConfig,
  type NextAction,
  type OneShot,
  type WebAgentListTarget,
  type WebAgentRun,
  type WebAgentVerb,
} from '@nff-brain/core';

export const WEB_AGENT_PLAN_TIMEOUT_MS = 60_000;
export const WEB_AGENT_FILTER_TIMEOUT_MS = 45_000;

export interface StartPlanningOptions {
  maxActions: number;
  listTarget: WebAgentListTarget | null;
  /** Auto mode: skip the awaiting_approval review step once the plan lands. */
  autoApprove: boolean;
  model?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Writes phase:'planning' synchronously and returns the run immediately —
 * the extension's 2.5s request timeout means the ROUTE HANDLER must never
 * await the LLM call this kicks off. Callers that need the final plan (tests,
 * `nff-brain` itself) can await runPlanningStep directly instead.
 */
export async function startPlanning(
  goal: string,
  clientId: string,
  opts: StartPlanningOptions,
  brain: OneShot = makeOneShot({ model: opts.model, timeoutMs: WEB_AGENT_PLAN_TIMEOUT_MS }),
): Promise<WebAgentRun> {
  const now = Date.now();
  const run: WebAgentRun = {
    id: newRunId(now),
    phase: 'planning',
    clientId,
    goal,
    autoApprove: opts.autoApprove,
    plan: null,
    listTarget: opts.listTarget,
    cursor: 0,
    pendingConnects: [],
    pendingConnectsStepId: null,
    actionsTaken: 0,
    maxActions: clampMaxActions(opts.maxActions),
    nextAllowedAtMs: now,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [],
  };
  const state = readWebAgentState();
  writeWebAgentState({ ...state, active: run });

  void runPlanningStep(run.id, goal, opts.maxActions, brain);
  return run;
}

/** Exported so tests can await the planning call directly instead of racing a fire-and-forget promise. */
export async function runPlanningStep(runId: string, goal: string, maxActions: number, brain: OneShot): Promise<void> {
  try {
    const raw = await brain(buildPlanPrompt(goal, { site: 'linkedin', maxActions }));
    const plan = parsePlanResponse(raw, { goal, site: 'linkedin', maxActions });
    updateActiveRun(runId, (run) => {
      // A Stop (or anything else) may have landed while this was in flight —
      // only a run still actually 'planning' should accept this result.
      if (run.phase !== 'planning') return run;
      if (!plan) return { ...run, phase: 'error', error: 'the planner returned no usable steps', updatedAt: nowIso() };
      // Auto mode: skip the review step entirely, same transition approvePlan() does.
      return run.autoApprove
        ? { ...run, phase: 'running', plan, nextAllowedAtMs: Date.now(), updatedAt: nowIso() }
        : { ...run, phase: 'awaiting_approval', plan, updatedAt: nowIso() };
    });
  } catch (err) {
    updateActiveRun(runId, (run) =>
      run.phase !== 'planning'
        ? run
        : { ...run, phase: 'error', error: err instanceof Error ? err.message : String(err), updatedAt: nowIso() },
    );
  }
}

/** Grace beyond the planner's own timeout before a 'planning' run is presumed orphaned. */
const PLAN_STALE_GRACE_MS = 30_000;

/**
 * Sweeps a 'planning' run whose server died mid-plan: runPlanningStep's
 * pending updater lives only in that process's memory, so a crash leaves
 * active.phase === 'planning' on disk with nothing left that could ever
 * resolve it — 409-blocking every future goal. A run still 'planning' well
 * past the planner's own timeout is expired to 'error', and
 * updateActiveRun's terminal auto-archive clears the active slot.
 */
export function expireStalePlanning(now: number = Date.now()): void {
  const active = readWebAgentState().active;
  if (!active || active.phase !== 'planning') return;
  if (now - Date.parse(active.updatedAt) <= WEB_AGENT_PLAN_TIMEOUT_MS + PLAN_STALE_GRACE_MS) return;
  updateActiveRun(active.id, (run) =>
    run.phase !== 'planning'
      ? run
      : { ...run, phase: 'error', error: 'planning timed out — stale run swept', updatedAt: nowIso() },
  );
}

/** No cross-client control: a run only ever answers to the client that started it. */
function owns(run: WebAgentRun, clientId: string): boolean {
  return run.clientId === clientId;
}

/**
 * The ownership gate, checked BEFORE any mutation attempt — updateActiveRun
 * always returns the (possibly unchanged) run once the id matches, so an
 * updater that merely declines to change an unowned run would still leak
 * that run's full data (goal text, plan, history) back to the caller. Every
 * mutating entry point below checks this first and returns null outright.
 */
function ownedActiveRun(runId: string, clientId: string): WebAgentRun | null {
  const active = readWebAgentState().active;
  return active && active.id === runId && owns(active, clientId) ? active : null;
}

export function approvePlan(runId: string, clientId: string): WebAgentRun | null {
  if (!ownedActiveRun(runId, clientId)) return null;
  return updateActiveRun(runId, (run) =>
    run.phase === 'awaiting_approval' ? { ...run, phase: 'running', nextAllowedAtMs: Date.now(), updatedAt: nowIso() } : run,
  );
}

export function rejectPlan(runId: string, clientId: string): WebAgentRun | null {
  if (!ownedActiveRun(runId, clientId)) return null;
  return updateActiveRun(runId, (run) =>
    run.phase === 'awaiting_approval' ? { ...run, phase: 'stopped', updatedAt: nowIso() } : run,
  );
}

/**
 * Idempotent — a run already terminal, not owned by this client, or not
 * found, is not an error (returns null rather than throwing; the route
 * handler treats that as ok:true regardless). 'planning'/'awaiting_approval'
 * have no in-flight browser action to wait for, so they go straight to
 * 'stopped' (and get archived immediately); only 'running' goes through
 * 'stopping', since an action may already be dispatched to the SW and its
 * result must still be allowed to land.
 */
export function requestStop(runId: string, clientId: string): WebAgentRun | null {
  if (!ownedActiveRun(runId, clientId)) return null;
  return updateActiveRun(runId, (run) => {
    if (run.phase === 'planning' || run.phase === 'awaiting_approval') {
      return { ...run, phase: 'stopped', updatedAt: nowIso() };
    }
    if (run.phase === 'running') {
      return { ...run, phase: 'stopping', updatedAt: nowIso() };
    }
    return run;
  });
}

export interface NextActionResult {
  action: NextAction | null;
  nextAllowedAtMs?: number;
}

/** The cap + pacing choke point's read side — mirrors gate.ts's shouldCapture() role. */
export function peekNextAction(clientId: string): NextActionResult {
  const run = readWebAgentState().active;
  if (!run || !owns(run, clientId)) return { action: null };
  if (!shouldGrantAction(run, Date.now())) return { action: null, nextAllowedAtMs: run.nextAllowedAtMs };
  return { action: decideNextAction(run) };
}

function stepsExhausted(run: WebAgentRun): boolean {
  return !run.plan || run.cursor >= run.plan.steps.length;
}

/**
 * Terminal-phase check run after every mutation below. A 'stopping' run
 * always wins immediately: by the time this runs, the one action that was
 * ever dispatched to the browser has already had its result folded in above
 * (clip + list-write, if it was a clickConnect) — anything still sitting in
 * pendingConnects was never handed out and has nothing "in flight" to finish,
 * so it is simply dropped rather than left to await a poll that will never
 * come (next-action only grants while phase === 'running').
 */
function finalize(run: WebAgentRun): WebAgentRun {
  if (run.phase === 'stopping') {
    return { ...run, phase: 'stopped', pendingConnects: [], pendingConnectsStepId: null, updatedAt: nowIso() };
  }
  if (run.pendingConnects.length > 0) return { ...run, updatedAt: nowIso() };
  if (stepsExhausted(run)) return { ...run, phase: 'done', updatedAt: nowIso() };
  return { ...run, updatedAt: nowIso() };
}

/**
 * Append the record and advance the cursor — deliberately does NOT call
 * finalize() itself. The readResultCards caller below still needs to attach
 * pendingConnects AFTER this before finalize can correctly decide whether
 * the run is actually done; calling finalize here first would see cursor
 * exhausted with pendingConnects still empty and terminate the run one step
 * too early, orphaning an about-to-be-queued clickConnect.
 */
function appendAndAdvance(run: WebAgentRun, record: ActionRecord): WebAgentRun {
  return { ...appendActionRecord(run, record), cursor: run.cursor + 1 };
}

export interface ReportedResult {
  ok: boolean;
  summary: string;
  fields?: Record<string, string>;
  cards?: AgentCardResult[];
}

export interface ReportActionResultParams {
  runId: string;
  clientId: string;
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
  result: ReportedResult;
}

export interface ReportActionResultDeps {
  brain?: OneShot;
  mcpServers?: McpServerConfig[];
}

/**
 * Async work (the filter LLM call, the list-write MCP call) happens BEFORE
 * the updateActiveRun mutation, which must itself stay synchronous — running
 * async work inside a read-modify-write would race a concurrent poll.
 */
export async function reportActionResult(
  params: ReportActionResultParams,
  deps: ReportActionResultDeps = {},
): Promise<WebAgentRun | null> {
  const run = readWebAgentState().active;
  if (!run || run.id !== params.runId || !owns(run, params.clientId)) return null;
  const reportedAt = nowIso();

  if (params.verb === 'navigate') {
    const record: ActionRecord = {
      stepId: params.stepId,
      verb: params.verb,
      args: params.args,
      requestedAt: reportedAt,
      result: { ok: params.result.ok, summary: params.result.summary, reportedAt },
    };
    return updateActiveRun(run.id, (r) => finalize(appendAndAdvance(r, record)));
  }

  if (params.verb === 'readResultCards') {
    const cards = params.result.cards ?? [];
    const record: ActionRecord = {
      stepId: params.stepId,
      verb: params.verb,
      args: params.args,
      requestedAt: reportedAt,
      result: { ok: params.result.ok, summary: params.result.summary, cards, reportedAt },
    };

    let queued: AgentCardResult[] = [];
    if (params.result.ok && cards.length > 0 && run.plan) {
      const brain = deps.brain ?? makeOneShot({ timeoutMs: WEB_AGENT_FILTER_TIMEOUT_MS });
      const filterCards = cards.map((c) => ({ name: c.name, headline: c.headline, company: c.company }));
      try {
        const raw = await brain(buildFilterPrompt(run.plan.criteria, filterCards));
        const matches = parseFilterResponse(raw, filterCards);
        const remainingCap = Math.max(0, run.maxActions - run.actionsTaken);
        queued = matches.slice(0, remainingCap).map((m) => cards[m.index]);
      } catch {
        queued = []; // fail closed: no matches rather than blocking the run
      }
    }

    return updateActiveRun(run.id, (r) => {
      const advanced = appendAndAdvance(r, record);
      return finalize({
        ...advanced,
        pendingConnects: queued,
        pendingConnectsStepId: queued.length > 0 ? params.stepId : null,
      });
    });
  }

  // clickConnect
  let listWriteError: string | undefined;
  if (params.result.ok && run.listTarget && params.result.fields) {
    listWriteError = await writeToList(run.listTarget, params.result.fields, deps.mcpServers, deps.brain ?? makeOneShot());
  }
  const record: ActionRecord = {
    stepId: params.stepId,
    verb: params.verb,
    args: params.args,
    requestedAt: reportedAt,
    result: { ok: params.result.ok, summary: params.result.summary, fields: params.result.fields, reportedAt, listWriteError },
  };

  return updateActiveRun(run.id, (r) => {
    const drained = { ...r, pendingConnects: r.pendingConnects.slice(1) };
    const cleared = drained.pendingConnects.length === 0 ? { ...drained, pendingConnectsStepId: null } : drained;
    const bumped = params.result.ok
      ? { ...cleared, actionsTaken: cleared.actionsTaken + 1, nextAllowedAtMs: computeNextAllowedAtMs(Date.now()) }
      : cleared;
    return finalize(appendActionRecord(bumped, record));
  });
}

/**
 * Never throws, never blocks the run: the LinkedIn connect already really
 * happened, so a list-write failure is recorded on the ActionRecord and the
 * run's progression must continue regardless.
 */
async function writeToList(
  target: WebAgentListTarget,
  fields: Record<string, string>,
  servers: McpServerConfig[] | undefined,
  brain: OneShot,
): Promise<string | undefined> {
  const server = servers?.find((s) => s.id === target.server);
  if (!server) return `MCP server "${target.server}" is no longer registered`;
  if (!server.enabled) return `MCP server "${server.name}" is disabled`;

  let args: Record<string, unknown> | null;
  try {
    const raw = await brain(buildToolArgsPrompt(target.toolDef, fields));
    args = parseToolArgsResponse(raw, target.toolDef);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!args) return `could not map the connected person's fields onto ${target.tool}'s expected arguments`;

  const result = await callMcpTool(server, target.tool, args);
  return result.ok ? undefined : result.error;
}
