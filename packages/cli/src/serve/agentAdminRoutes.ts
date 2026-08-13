// /v1/admin/agent/* — the web agent's ADMIN surface: loopback-only,
// adminToken-authenticated, origin:'absent' (no browser, ever), same trust
// tier as /v1/admin/pair-window. This is how `nff-brain agent …` and the eval
// harness drive a run WITHOUT holding the extension's bearer token (only its
// sha256 ever touches disk, so no local process can impersonate the paired
// client — instead admin explicitly acts on the owning client's behalf).
//
// A submitted run is ATTRIBUTED to a paired extension client: the SW's normal
// /v1/agent/status poll picks it up untouched, executes it, and reports
// results through the ordinary client routes. Admin never executes anything.

import {
  findClientById,
  isTerminalPhase,
  readWebAgentState,
  WEB_AGENT_MAX_ACTIONS_CEILING,
  type WebAgentRun,
} from '@nff-brain/core';
import { approvePlan, rejectPlan, requestStop, startPlanning } from '../webAgentRun.js';
import { parseListTarget } from './agentRoutes.js';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

const ADMIN_GOAL_BODY_MAX = 8 * 1024;
const ADMIN_RUN_BODY_MAX = 1 * 1024;
const ADMIN_GOAL_MAX = 500;

const adminAgentGoal: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, ADMIN_GOAL_BODY_MAX)) as {
    goal?: unknown;
    client?: unknown;
    maxActions?: unknown;
    listTarget?: unknown;
    autoApprove?: unknown;
    model?: unknown;
  };
  const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, ADMIN_GOAL_MAX) : '';
  if (!goal) {
    sendError(res, 400, 'bad_request', 'a goal is required', ctx.cors);
    return;
  }

  // Resolve which paired client will EXECUTE the run. Explicit `client` wins;
  // otherwise a sole paired client is unambiguous; anything else is an error
  // rather than a guess — attributing a run to the wrong browser would have it
  // silently start acting there.
  const cfg = ctx.state.config();
  let clientId: string;
  const requested = typeof body.client === 'string' ? body.client : '';
  if (requested) {
    if (!findClientById(cfg, requested)) {
      sendError(res, 400, 'unknown_client', `no paired client with id ${requested}`, ctx.cors);
      return;
    }
    clientId = requested;
  } else if (cfg.clients.length === 1) {
    clientId = cfg.clients[0].id;
  } else if (cfg.clients.length === 0) {
    sendError(res, 409, 'no_client', 'no extension is paired — run `nff-brain pair` first', ctx.cors);
    return;
  } else {
    const ids = cfg.clients.map((c) => c.id).join(', ');
    sendError(res, 400, 'ambiguous_client', `multiple paired clients — pass one of: ${ids}`, ctx.cors);
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
  const run = await startPlanning(goal, clientId, {
    maxActions,
    listTarget: parseListTarget(body.listTarget),
    autoApprove: body.autoApprove === true,
    model: typeof body.model === 'string' ? body.model : undefined,
  });
  sendJson(res, 201, { ok: true, runId: run.id, clientId }, ctx.cors);
};

/**
 * Unscoped, and includes `recent`: terminal runs are archived out of `active`
 * the instant they finish (updateActiveRun → archiveActiveRun), so a caller
 * that polled its way to the end needs the archive to read the final phase
 * and history. `?run=<id>` narrows to one run across active + recent.
 */
const adminAgentStatus: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const runId = url.searchParams.get('run');
  const state = readWebAgentState();
  if (runId) {
    const run =
      state.active?.id === runId ? state.active : (state.recent.find((r) => r.id === runId) ?? null);
    sendJson(res, 200, { ok: true, run }, ctx.cors);
    return;
  }
  sendJson(res, 200, { ok: true, run: state.active, recent: state.recent }, ctx.cors);
};

function readRunId(body: unknown): string {
  const v = (body as { runId?: unknown })?.runId;
  return typeof v === 'string' ? v : '';
}

/**
 * Admin approve/reject/stop act ON BEHALF OF the run's own client (the
 * ownership guard in webAgentRun.ts stays intact for the paired surface);
 * an id that doesn't match the active run resolves to null / no-op.
 */
function activeOwner(runId: string): string | null {
  const active = readWebAgentState().active;
  return active && active.id === runId ? active.clientId : null;
}

const adminAgentApprove: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, ADMIN_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  const owner = activeOwner(runId);
  const run: WebAgentRun | null = owner ? approvePlan(runId, owner) : null;
  sendJson(res, 200, { ok: true, run }, ctx.cors);
};

const adminAgentReject: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, ADMIN_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  const owner = activeOwner(runId);
  const run: WebAgentRun | null = owner ? rejectPlan(runId, owner) : null;
  sendJson(res, 200, { ok: true, run }, ctx.cors);
};

const adminAgentStop: Handler = async (req, res, ctx) => {
  const runId = readRunId(await readJsonBody(req, ADMIN_RUN_BODY_MAX));
  if (!runId) {
    sendError(res, 400, 'bad_request', 'runId is required', ctx.cors);
    return;
  }
  // Same idempotency contract as the paired stop route.
  const owner = activeOwner(runId);
  if (owner) requestStop(runId, owner);
  sendJson(res, 200, { ok: true }, ctx.cors);
};

export const AGENT_ADMIN_ROUTES: Record<string, Route> = {
  '/v1/admin/agent/goal': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminAgentGoal },
  '/v1/admin/agent/status': { method: 'GET', auth: 'admin', origin: 'absent', handler: adminAgentStatus },
  '/v1/admin/agent/approve': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminAgentApprove },
  '/v1/admin/agent/reject': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminAgentReject },
  '/v1/admin/agent/stop': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminAgentStop },
};
