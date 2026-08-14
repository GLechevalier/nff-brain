// GET /v1/workflows + POST /v1/trace — paired-mode Record & automate. The
// standalone/BYOK path distills a finished recording into a workflow node
// entirely in the browser (standaloneTraceDistill.ts); this is the server-side
// twin, run through the user's local `claude -p` instead of their own API key.
// Same trust tier as /v1/chat and /v1/act/step (auth:'client', origin:'paired'):
// a paired client can already drive `claude -p` via those routes, so this adds
// no new capability class.
//
// The wire TraceRecord is untrusted end to end: every event goes through
// core's normalizeTraceEvent (the exact same clamp the SW itself runs on a
// content script's raw events — trace.ts's header says as much), and the
// distiller's reply is re-validated through validateWorkflowSpec (via
// parseWorkflowResponse) before it ever reaches the brain. workflow.ts's own
// header: origin 'workflow' is a trust tier, like 'clip' — never merged or
// folded, its own eviction budget (MAX_WORKFLOW_NODES).

import {
  MAX_TRACE_BYTES,
  MAX_TRACE_EVENTS,
  applyWorkflow,
  buildWorkflowPrompt,
  makeOneShot,
  mutateBrain,
  normalizeTraceEvent,
  parseWorkflowResponse,
} from '@nff-brain/core';
import type { CaptureTarget, OneShot, TraceEvent, TraceRecord } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

// Events are already capped at MAX_TRACE_EVENTS × their own per-field caps;
// this just bounds the wire body a bit above MAX_TRACE_BYTES for the rest of
// the record's metadata (id/title/urls), same headroom style as importRoutes.
const TRACE_BODY_MAX = MAX_TRACE_BYTES + 64 * 1024;
// A distillation is one claude -p round trip over a compacted trace — same
// budget as chat/act, and this route's own error must land before the
// client's fetch (client.ts's CHAT_TIMEOUT_MS) aborts it first.
const TRACE_TIMEOUT_MS = 90_000;

const TITLE_MAX = 200;
const URL_MAX = 2000;
const ID_MAX = 80;
const DATE_MAX = 40;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

// ── GET /v1/workflows ────────────────────────────────────────────────────────

/** Same shape the standalone path's `getWorkflows` case already returns from
 *  the local brain — the extension side needs no translation to go paired. */
const workflows: Handler = (_req, res, ctx) => {
  const merged = ctx.state.mergedBrain();
  const items = merged.nodes
    .filter((n) => n.origin === 'workflow' && n.workflow)
    .map((n) => ({
      id: n.id,
      title: n.title,
      intent: n.workflow!.intent,
      site: n.workflow!.site,
      params: n.workflow!.params.map((p) => p.name),
    }));
  sendJson(res, 200, { ok: true, items }, ctx.cors);
};

// ── GET /v1/workflow — ONE workflow's full replayable spec ───────────────────

const WORKFLOW_ID_MAX = 80;

/** The web agent's workflow-replay path (actRun.ts's loadWorkflow) needs the
 *  full WorkflowSpec (steps included), unlike /v1/workflows' summary list. */
const workflow: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const id = (url.searchParams.get('id') ?? '').slice(0, WORKFLOW_ID_MAX);
  if (!id) {
    sendError(res, 400, 'bad_request', 'a workflow id is required', ctx.cors);
    return;
  }
  const node = ctx.state.mergedBrain().nodes.find((n) => n.id === id && n.origin === 'workflow' && n.workflow);
  if (!node) {
    sendError(res, 404, 'not_found', 'no such workflow', ctx.cors);
    return;
  }
  sendJson(res, 200, { ok: true, id: node.id, title: node.title, spec: node.workflow }, ctx.cors);
};

// ── POST /v1/trace ───────────────────────────────────────────────────────────

export interface TraceRouteDeps {
  distill?: OneShot;
}

/** Exported so tests can inject a fake distiller without spawning claude -p. */
export function makeTraceHandler(deps: TraceRouteDeps = {}): Handler {
  const handler: Handler = async (req, res, ctx) => {
    const body = (await readJsonBody(req, TRACE_BODY_MAX)) as {
      id?: unknown;
      startedAt?: unknown;
      endedAt?: unknown;
      startUrl?: unknown;
      title?: unknown;
      events?: unknown;
      target?: unknown;
    };

    const rawEvents = Array.isArray(body?.events) ? body.events.slice(0, MAX_TRACE_EVENTS) : [];
    const events = rawEvents.map(normalizeTraceEvent).filter((e): e is TraceEvent => e !== null);
    if (events.length === 0) {
      sendError(res, 400, 'bad_request', 'a recording needs at least one usable event', ctx.cors);
      return;
    }

    const endedAt =
      typeof body?.endedAt === 'string' && body.endedAt.length <= DATE_MAX ? body.endedAt : new Date().toISOString();
    const trace: TraceRecord = {
      v: 1,
      id: typeof body?.id === 'string' && body.id.trim() ? body.id.trim().slice(0, ID_MAX) : `trc_${Date.now()}`,
      startedAt: typeof body?.startedAt === 'string' && body.startedAt.length <= DATE_MAX ? body.startedAt : endedAt,
      endedAt,
      startUrl: typeof body?.startUrl === 'string' ? body.startUrl.trim().slice(0, URL_MAX) : '',
      title: typeof body?.title === 'string' ? body.title.trim().slice(0, TITLE_MAX) || undefined : undefined,
      events,
      source: 'chrome',
    };

    const { prompt } = buildWorkflowPrompt(trace);
    const distill = deps.distill ?? makeOneShot({ timeoutMs: TRACE_TIMEOUT_MS });
    let raw: string;
    try {
      raw = await distill(prompt);
    } catch (err) {
      sendError(res, 502, 'trace_error', err instanceof Error ? err.message : 'the brain did not answer in time', ctx.cors);
      return;
    }

    const spec = parseWorkflowResponse(raw, {
      sourceTraceId: trace.id,
      recordedAt: trace.endedAt,
      site: hostOf(trace.startUrl),
    });
    if (!spec) {
      sendError(res, 502, 'trace_error', 'could not turn this recording into a workflow — try recording again', ctx.cors);
      return;
    }

    const cfg = ctx.state.config();
    const target: CaptureTarget =
      body?.target === 'project' ? 'project' : body?.target === 'global' ? 'global' : cfg.capture.defaultTarget;
    const brainPath = ctx.state.targetBrainPath(target);

    const result = mutateBrain(brainPath, (brain) => applyWorkflow(brain, spec, trace.title || spec.intent));
    sendJson(res, 201, { ok: true, nodeId: result.id, evicted: result.evicted }, ctx.cors);
  };
  return handler;
}

export const TRACE_ROUTES: Record<string, Route> = {
  '/v1/workflows': { method: 'GET', auth: 'client', origin: 'paired', handler: workflows },
  '/v1/workflow': { method: 'GET', auth: 'client', origin: 'paired', handler: workflow },
  '/v1/trace': { method: 'POST', auth: 'client', origin: 'paired', handler: makeTraceHandler() },
};
