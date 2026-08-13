// /v1/agent/* — the web agent's HTTP surface. Same trust tier as /v1/clip
// (auth:'client', origin:'paired'). Handlers stay thin: parse/validate the
// wire body, call into ../webAgentRun.ts for everything stateful. See
// docs/EPIC-chrome.md item 7.

import {
  WEB_AGENT_MAX_ACTIONS_CEILING,
  isTerminalPhase,
  loadMcpServers,
  readWebAgentState,
  type AgentCardResult,
  type McpToolDef,
  type WebAgentListTarget,
  type WebAgentVerb,
} from '@nff-brain/core';
import {
  approvePlan,
  peekNextAction,
  rejectPlan,
  reportActionResult,
  requestStop,
  startPlanning,
  type ReportedResult,
} from '../webAgentRun.js';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

const AGENT_GOAL_BODY_MAX = 4 * 1024;
const AGENT_RUN_BODY_MAX = 1 * 1024;
const AGENT_RESULT_BODY_MAX = 16 * 1024;
const AGENT_GOAL_MAX = 500;

function parseToolDef(v: unknown): McpToolDef | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof d.name !== 'string') return null;
  return {
    name: d.name,
    description: typeof d.description === 'string' ? d.description : undefined,
    inputSchema: d.inputSchema && typeof d.inputSchema === 'object' ? (d.inputSchema as Record<string, unknown>) : {},
  };
}

/**
 * The extension already fetched this tool's schema via GET /v1/mcp/tools for
 * its own dropdown moments earlier, so the goal submission carries the
 * snapshot inline — a server-side re-fetch here would be a second network
 * call inside a route that must answer well within the extension's 2.5s
 * request timeout, for a client that already holds the same trust level as
 * a direct /v1/mcp/call.
 */
export function parseListTarget(v: unknown): WebAgentListTarget | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as { server?: unknown; tool?: unknown; toolDef?: unknown };
  const toolDef = parseToolDef(t.toolDef);
  if (typeof t.server !== 'string' || typeof t.tool !== 'string' || !toolDef) return null;
  return { server: t.server, tool: t.tool, toolDef };
}

const agentGoal: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, AGENT_GOAL_BODY_MAX)) as {
    goal?: unknown;
    maxActions?: unknown;
    listTarget?: unknown;
    autoApprove?: unknown;
  };
  const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, AGENT_GOAL_MAX) : '';
  if (!goal) {
    sendError(res, 400, 'bad_request', 'a goal is required', ctx.cors);
    return;
  }

  const active = readWebAgentState().active;
  if (active && !isTerminalPhase(active.phase)) {
    sendError(res, 409, 'run_active', 'a web agent run is already active — stop it first', ctx.cors);
    return;
  }

  const maxActions =
    typeof body.maxActions === 'number' && Number.isFinite(body.maxActions)
      ? body.maxActions
      : WEB_AGENT_MAX_ACTIONS_CEILING;
  const listTarget = parseListTarget(body.listTarget);
  const autoApprove = body.autoApprove === true;

  const run = await startPlanning(goal, ctx.client!.id, { maxActions, listTarget, autoApprove });
  sendJson(res, 201, { ok: true, runId: run.id }, ctx.cors);
};

/** Scoped to the requesting client — a run never leaks another paired browser's goal text. */
const agentStatus: Handler = (_req, res, ctx) => {
  const active = readWebAgentState().active;
  const run = active && active.clientId === ctx.client!.id ? active : null;
  sendJson(res, 200, { ok: true, run }, ctx.cors);
};

function readRunId(body: unknown): string {
  const v = (body as { runId?: unknown })?.runId;
  return typeof v === 'string' ? v : '';
}

const agentApprove: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, AGENT_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  sendJson(res, 200, { ok: true, run: approvePlan(runId, ctx.client!.id) }, ctx.cors);
};

const agentReject: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, AGENT_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  sendJson(res, 200, { ok: true, run: rejectPlan(runId, ctx.client!.id) }, ctx.cors);
};

const agentStop: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, AGENT_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  // Idempotent by design — stopping an already-terminal, unowned or unknown
  // run is still ok:true; the SW never needs to special-case this.
  requestStop(runId, ctx.client!.id);
  sendJson(res, 200, { ok: true }, ctx.cors);
};

const agentNextAction: Handler = (_req, res, ctx) => {
  const { action, nextAllowedAtMs } = peekNextAction(ctx.client!.id);
  sendJson(res, 200, { ok: true, action, nextAllowedAtMs }, ctx.cors);
};

interface ActionResultBody {
  runId?: unknown;
  stepId?: unknown;
  verb?: unknown;
  args?: unknown;
  result?: { ok?: unknown; summary?: unknown; fields?: unknown; cards?: unknown };
}

const VERBS: readonly WebAgentVerb[] = ['navigate', 'readResultCards', 'clickConnect'];

function readArgs(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function readFields(v: unknown): Record<string, string> | undefined {
  const args = readArgs(v);
  return Object.keys(args).length > 0 ? args : undefined;
}

function readCards(v: unknown): AgentCardResult[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AgentCardResult[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const c = item as { cardIndex?: unknown; name?: unknown; headline?: unknown; company?: unknown };
    if (typeof c.cardIndex !== 'number' || typeof c.name !== 'string' || typeof c.headline !== 'string') continue;
    out.push({
      cardIndex: c.cardIndex,
      name: c.name,
      headline: c.headline,
      company: typeof c.company === 'string' ? c.company : undefined,
    });
  }
  return out;
}

function readResult(v: ActionResultBody['result']): ReportedResult {
  return {
    ok: v?.ok === true,
    summary: typeof v?.summary === 'string' ? v.summary.slice(0, 300) : '',
    fields: readFields(v?.fields),
    cards: readCards(v?.cards),
  };
}

const agentActionResult: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, AGENT_RESULT_BODY_MAX)) as ActionResultBody;
  const runId = typeof body.runId === 'string' ? body.runId : '';
  const stepId = typeof body.stepId === 'string' ? body.stepId : '';
  const verb =
    typeof body.verb === 'string' && (VERBS as readonly string[]).includes(body.verb) ? (body.verb as WebAgentVerb) : null;
  if (!runId || !stepId || !verb) {
    sendError(res, 400, 'bad_request', 'runId, stepId and a known verb are required', ctx.cors);
    return;
  }

  const run = await reportActionResult(
    { runId, clientId: ctx.client!.id, stepId, verb, args: readArgs(body.args), result: readResult(body.result) },
    { mcpServers: loadMcpServers() },
  );
  sendJson(res, 200, { ok: true, run }, ctx.cors);
};

export const AGENT_ROUTES: Record<string, Route> = {
  '/v1/agent/goal': { method: 'POST', auth: 'client', origin: 'paired', handler: agentGoal },
  '/v1/agent/status': { method: 'GET', auth: 'client', origin: 'paired', handler: agentStatus },
  '/v1/agent/plan/approve': { method: 'POST', auth: 'client', origin: 'paired', handler: agentApprove },
  '/v1/agent/plan/reject': { method: 'POST', auth: 'client', origin: 'paired', handler: agentReject },
  '/v1/agent/stop': { method: 'POST', auth: 'client', origin: 'paired', handler: agentStop },
  '/v1/agent/next-action': { method: 'GET', auth: 'client', origin: 'paired', handler: agentNextAction },
  '/v1/agent/action-result': { method: 'POST', auth: 'client', origin: 'paired', handler: agentActionResult },
};
