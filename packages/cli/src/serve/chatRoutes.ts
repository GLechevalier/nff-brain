// /v1/chat — the Brain tab's Manual-mode chat. Same trust tier as /v1/clip
// (auth:'client', origin:'paired'). Unlike the web agent, a chat exchange is
// a plain request/response with nothing to survive a page close or a
// multi-minute pace, so the simplest correct design is a route that just
// awaits runClaude() directly — no job/poll state. The extension pairs this
// with a longer-than-usual client timeout (see client.ts's askChat()) rather
// than the blanket 2.5s every other route lives within.

import { buildChatPrompt, cleanChatAnswer, fuseRanked, makeOneShot } from '@nff-brain/core';
import type { ChatTurn, OneShot } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

const CHAT_BODY_MAX = 16 * 1024;
// A few seconds BELOW the extension's own CHAT_TIMEOUT_MS (protocol.ts) on
// purpose — this route's own timeout must fire and send its specific error
// before the client's fetch aborts, or the panel only ever shows the
// client's generic "did not answer in time" instead of the real cause.
const CHAT_TIMEOUT_MS = 90_000;
const CHAT_RETRIEVAL_LIMIT = 8;
const CHAT_HISTORY_MAX = 6;

function readHistory(v: unknown): ChatTurn[] {
  if (!Array.isArray(v)) return [];
  const out: ChatTurn[] = [];
  for (const item of v.slice(-CHAT_HISTORY_MAX)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as { role?: unknown; text?: unknown };
    if ((t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string') {
      out.push({ role: t.role, text: t.text });
    }
  }
  return out;
}

export interface ChatRouteDeps {
  brain?: OneShot;
}

/** Exported so tests can inject a fake brain without spawning a real subprocess. */
export function makeChatHandler(deps: ChatRouteDeps = {}): Handler {
  const handler: Handler = async (req, res, ctx) => {
    const body = (await readJsonBody(req, CHAT_BODY_MAX)) as { message?: unknown; history?: unknown };
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      sendError(res, 400, 'bad_request', 'a message is required', ctx.cors);
      return;
    }
    const history = readHistory(body?.history);

    const merged = ctx.state.mergedBrain();
    const ranked = fuseRanked(message, merged.nodes, null, { limit: CHAT_RETRIEVAL_LIMIT });
    const nodes = ranked.map((r) => ({ id: r.node.id, title: r.node.title, content: r.node.content ?? '' }));

    const brain = deps.brain ?? makeOneShot({ timeoutMs: CHAT_TIMEOUT_MS });
    let raw: string;
    try {
      raw = await brain(buildChatPrompt({ message, history, nodes }));
    } catch (err) {
      sendError(res, 502, 'chat_error', err instanceof Error ? err.message : 'the brain did not answer in time', ctx.cors);
      return;
    }

    const answer = cleanChatAnswer(raw);
    const sources = nodes.map((n) => ({ id: n.id, title: n.title }));
    sendJson(res, 200, { ok: true, answer, sources }, ctx.cors);
  };
  return handler;
}

export const CHAT_ROUTES: Record<string, Route> = {
  '/v1/chat': { method: 'POST', auth: 'client', origin: 'paired', handler: makeChatHandler() },
};
