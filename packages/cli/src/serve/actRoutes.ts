// /v1/act/step — the web agent's brain step for PAIRED mode. The extension's
// action loop lives in the service worker (that is where chrome.debugger is);
// each turn it sends the assembled prompt here, the server runs it through the
// user's local `claude -p` (their Claude Code login — no API key), and returns
// the raw text, from which the SW parses ONE JSON action. Same trust tier as
// /v1/chat (auth:'client', origin:'paired', loopback only): a paired client can
// already drive `claude -p` via /v1/chat, so this adds no new capability class —
// it just skips the brain-retrieval wrapper because the agent supplies its own
// full context (page snapshot + action history).

import { makeOneShot } from '@nff-brain/core';
import type { OneShot } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

// Snapshots are large; allow a bigger body than /v1/chat's 16 KB, still bounded.
const ACT_BODY_MAX = 128 * 1024;
// A few seconds below the client's own ACT_STEP_TIMEOUT_MS so this route's error
// lands before the fetch aborts (same reasoning as chatRoutes' CHAT_TIMEOUT_MS).
const ACT_TIMEOUT_MS = 90_000;

export interface ActRouteDeps {
  brain?: OneShot;
}

/** Exported so tests can inject a fake brain instead of spawning claude -p. */
export function makeActStepHandler(deps: ActRouteDeps = {}): Handler {
  const handler: Handler = async (req, res, ctx) => {
    const body = (await readJsonBody(req, ACT_BODY_MAX)) as { prompt?: unknown };
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      sendError(res, 400, 'bad_request', 'a prompt is required', ctx.cors);
      return;
    }

    const brain = deps.brain ?? makeOneShot({ timeoutMs: ACT_TIMEOUT_MS });
    let text: string;
    try {
      text = await brain(prompt);
    } catch (err) {
      sendError(res, 502, 'act_error', err instanceof Error ? err.message : 'the agent brain did not answer in time', ctx.cors);
      return;
    }
    sendJson(res, 200, { ok: true, text }, ctx.cors);
  };
  return handler;
}

export const ACT_ROUTES: Record<string, Route> = {
  '/v1/act/step': { method: 'POST', auth: 'client', origin: 'paired', handler: makeActStepHandler() },
};
