// /v1/act/step — the web agent's brain step for PAIRED mode. The extension's
// action loop lives in the service worker (that is where chrome.debugger is);
// each turn it sends the assembled prompt here, the server runs it through the
// user's local `claude -p` (their Claude Code login — no API key), and returns
// the raw text, from which the SW parses ONE JSON action. Same trust tier as
// /v1/chat (auth:'client', origin:'paired', loopback only): a paired client can
// already drive `claude -p` via /v1/chat, so this adds no new capability class —
// it just skips the brain-retrieval wrapper because the agent supplies its own
// full context (page snapshot + action history).

import { ClaudeSession, makeOneShot } from '@nff-brain/core';
import type { OneShot } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';
import type { ActSessionEntry, ServeState } from './state.js';

// Snapshots are large; allow a bigger body than /v1/chat's 16 KB, still bounded.
const ACT_BODY_MAX = 128 * 1024;
// A few seconds below the client's own ACT_STEP_TIMEOUT_MS so this route's error
// lands before the fetch aborts (same reasoning as chatRoutes' CHAT_TIMEOUT_MS).
const ACT_TIMEOUT_MS = 90_000;

// Session policy. Env-read lazily so tests can flip them per server.
const RUN_ID_RE = /^act_[A-Za-z0-9_]{1,64}$/;
const ACT_MAX_SESSIONS = 2;
// Only aliases, never a raw string: with shell:true on Windows the model lands
// in a shell command line, and claude.ts's safety argument is "every arg is a
// fixed literal" — a whitelist keeps that literally true.
const ACT_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const actIdleMs = (): number => Number(process.env.NFF_BRAIN_ACT_IDLE_MS) || 5 * 60_000;
const actMaxLifeMs = (): number => Number(process.env.NFF_BRAIN_ACT_MAX_LIFE_MS) || 30 * 60_000;
const sessionsEnabled = (): boolean => process.env.NFF_BRAIN_ACT_SESSION !== '0';

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

// ── persistent per-run sessions ──────────────────────────────────────────────
//
// /v1/act/step spawns a fresh `claude -p` per action — a full CLI cold start
// plus re-tokenizing the whole rebuilt prompt, every turn. The session routes
// keep ONE stream-json claude process per act-run instead: the extension sends
// the full legacy prompt as `bootstrap` (spawn/respawn fuel) plus a small
// per-turn `message`, so turns 2+ cost model inference on a cached prefix.
// /v1/act/step stays untouched — it IS the old-extension compatibility path.

export interface ActSessionDeps {
  /** Tests inject a fake session factory instead of spawning claude. */
  newSession?: (model?: string) => ActSessionEntry['session'];
}

function endSession(state: ServeState, runId: string): boolean {
  const entry = state.actSessions.get(runId);
  if (!entry) return false;
  clearTimeout(entry.idleTimer);
  entry.session.end();
  state.actSessions.delete(runId);
  return true;
}

function armIdleTimer(state: ServeState, runId: string, entry: ActSessionEntry): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => endSession(state, runId), actIdleMs());
  entry.idleTimer.unref?.();
}

/** Get a live session for the run, spawning (and bootstrapping) when needed.
 *  Returns the reply text of `message` — or of `bootstrap` on a fresh spawn,
 *  which is equivalent: the bootstrap prompt already ends with this turn's
 *  history and "reply with the next action". */
async function stepSession(
  state: ServeState,
  deps: ActSessionDeps,
  runId: string,
  bootstrap: string,
  message: string,
  model: string | undefined,
): Promise<string> {
  const make = deps.newSession ?? ((m?: string) => new ClaudeSession({ model: m, sendTimeoutMs: ACT_TIMEOUT_MS }));

  let entry = state.actSessions.get(runId);
  if (entry && (Date.now() - entry.startedAtMs > actMaxLifeMs() || !entry.session.alive)) {
    endSession(state, runId);
    entry = undefined;
  }

  if (entry) {
    // Disarm while the turn is in flight — an in-flight send IS activity, and
    // a short idle window must never kill the session mid-turn. Re-armed on
    // success; every failure path removes the entry (and its timer) instead.
    clearTimeout(entry.idleTimer);
    try {
      const text = await entry.session.send(message);
      armIdleTimer(state, runId, entry);
      return text;
    } catch (err) {
      endSession(state, runId);
      // A dead process respawns transparently (bootstrap carries the compact
      // history); a TIMEOUT must not retry — the client's own fetch deadline
      // would expire mid-retry and the run would fail worse.
      if (err instanceof Error && /timed out/.test(err.message)) throw err;
    }
  }

  // Fresh spawn (first turn, expired, evicted, or just died).
  while (state.actSessions.size >= ACT_MAX_SESSIONS) {
    const oldest = [...state.actSessions.entries()].sort((a, b) => a[1].startedAtMs - b[1].startedAtMs)[0];
    if (!oldest) break;
    endSession(state, oldest[0]);
  }
  const fresh: ActSessionEntry = {
    session: make(model),
    idleTimer: setTimeout(() => {}, 0),
    startedAtMs: Date.now(),
  };
  state.actSessions.set(runId, fresh);
  try {
    const text = await fresh.session.send(bootstrap);
    armIdleTimer(state, runId, fresh);
    return text;
  } catch (err) {
    endSession(state, runId);
    throw err;
  }
}

export function makeActSessionHandlers(deps: ActSessionDeps = {}): { step: Handler; end: Handler } {
  const step: Handler = async (req, res, ctx) => {
    const body = (await readJsonBody(req, ACT_BODY_MAX)) as {
      runId?: unknown;
      bootstrap?: unknown;
      message?: unknown;
      model?: unknown;
    };
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    const bootstrap = typeof body?.bootstrap === 'string' ? body.bootstrap : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!RUN_ID_RE.test(runId) || !bootstrap.trim() || !message.trim()) {
      sendError(res, 400, 'bad_request', 'runId, bootstrap and message are required', ctx.cors);
      return;
    }
    const model = typeof body.model === 'string' && ACT_MODELS.has(body.model) ? body.model : undefined;

    let text: string;
    try {
      text = sessionsEnabled()
        ? await stepSession(ctx.state, deps, runId, bootstrap, message, model)
        : await makeOneShot({ timeoutMs: ACT_TIMEOUT_MS })(bootstrap);
    } catch (err) {
      sendError(res, 502, 'act_error', err instanceof Error ? err.message : 'the agent brain did not answer in time', ctx.cors);
      return;
    }
    sendJson(res, 200, { ok: true, text }, ctx.cors);
  };

  const end: Handler = async (req, res, ctx) => {
    const body = (await readJsonBody(req, ACT_BODY_MAX)) as { runId?: unknown };
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    if (!RUN_ID_RE.test(runId)) {
      sendError(res, 400, 'bad_request', 'a runId is required', ctx.cors);
      return;
    }
    sendJson(res, 200, { ok: true, ended: endSession(ctx.state, runId) }, ctx.cors);
  };

  return { step, end };
}

const sessionHandlers = makeActSessionHandlers();

export const ACT_ROUTES: Record<string, Route> = {
  '/v1/act/step': { method: 'POST', auth: 'client', origin: 'paired', handler: makeActStepHandler() },
  '/v1/act/session/step': { method: 'POST', auth: 'client', origin: 'paired', handler: sessionHandlers.step },
  '/v1/act/session/end': { method: 'POST', auth: 'client', origin: 'paired', handler: sessionHandlers.end },
};
