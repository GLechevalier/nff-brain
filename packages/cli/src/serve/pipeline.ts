// The request pipeline: ten gates, in this order, ALL of them before any body
// is read and before the route handler runs. The order is the security model —
// see packages/core/src/serveAuth.ts for the threat model each gate answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EXTENSION_ORIGIN_RE,
  hashToken,
  isAllowedFetchContext,
  isAllowedHost,
  isAllowedOrigin,
  tokenMatches,
} from '@nff-brain/core';
import type { BucketName } from '@nff-brain/core';
import { BodyError, bearer, corsHeaders, header, sendError, sendJson } from './http.js';
import { ROUTES } from './routes.js';
import type { OriginPolicy, RequestContext, Route } from './routes.js';
import type { ServeState } from './state.js';

const METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

type OriginVerdict = { ok: true; origin?: string } | { ok: false };

function checkOrigin(policy: OriginPolicy, origin: string | undefined, state: ServeState): OriginVerdict {
  const extensionish = (o: string) => EXTENSION_ORIGIN_RE.test(o) || state.opts.allowOrigins.includes(o);

  switch (policy) {
    case 'paired':
      return isAllowedOrigin(origin, state.allowedOrigins()) ? { ok: true, origin } : { ok: false };
    case 'extension':
      return origin && extensionish(origin) ? { ok: true, origin } : { ok: false };
    case 'lenient':
      if (!origin) return { ok: true };
      return extensionish(origin) || isAllowedOrigin(origin, state.allowedOrigins())
        ? { ok: true, origin }
        : { ok: false };
    case 'absent':
      // Admin routes. A browser ALWAYS sends Origin on a cross-origin fetch, so
      // requiring its absence is what makes these unreachable from any page.
      return origin ? { ok: false } : { ok: true };
  }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, state: ServeState): Promise<void> {
  // ── 1. loopback only ───────────────────────────────────────────────────────
  // The socket is bound to 127.0.0.1, so this is belt and braces against a
  // misconfigured bind rather than a live threat. Destroy, do not answer.
  if (!isLoopback(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }

  // ── 2. method ──────────────────────────────────────────────────────────────
  const method = req.method ?? 'GET';
  if (!METHODS.has(method)) {
    sendError(res, 405, 'method_not_allowed', `${method} is not supported`, { allow: 'GET, POST, OPTIONS' });
    return;
  }

  // ── 3. Host — the DNS-rebinding kill ───────────────────────────────────────
  // A rebound page reaches us as SAME-ORIGIN, so gate 5 never fires and CORS
  // does not apply. The Host header is the only thing that still gives it away.
  // Answered with NO CORS headers, deliberately.
  if (!isAllowedHost(header(req, 'host'), state.port)) {
    sendError(res, 403, 'bad_host', 'unexpected Host header');
    return;
  }

  // ── 4. static route table ──────────────────────────────────────────────────
  const pathname = pathnameOf(req.url);
  const route: Route | undefined = ROUTES[pathname];
  if (!route) {
    sendError(res, 404, 'not_found', 'no such endpoint');
    return;
  }

  // ── 5. Origin ──────────────────────────────────────────────────────────────
  const origin = header(req, 'origin');
  const verdict = checkOrigin(route.origin, origin, state);
  if (!verdict.ok) {
    // A rejected origin is the ONLY thing that ever fills the anon bucket: a
    // hostile page never reaches gate 9, so counting it here is what makes the
    // bucket real. It is also why the paired client can never be starved — the
    // page is only ever spending its own budget.
    state.buckets.fail('anon');
    if (state.buckets.throttled('anon')) {
      sendError(res, 429, 'rate_limited', 'too many rejected requests', {
        'retry-after': String(state.buckets.retryAfterSec('anon')),
      });
      return;
    }
    sendError(res, 403, 'forbidden_origin', 'this origin is not paired with the brain');
    return;
  }
  const cors = verdict.origin
    ? corsHeaders({
        origin: verdict.origin,
        privateNetwork: header(req, 'access-control-request-private-network') === 'true',
      })
    : {};

  // ── 6. preflight — BEFORE auth, and this is the one people get wrong ───────
  // A CORS preflight carries no Authorization header. Running auth first makes
  // every extension call fail as an opaque "CORS policy" error in Chrome, with
  // nothing in the message to suggest the problem is authentication.
  if (method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'content-length': '0' });
    res.end();
    return;
  }

  if (method !== route.method) {
    sendError(res, 405, 'method_not_allowed', `${pathname} accepts ${route.method}`, { allow: route.method, ...cors });
    return;
  }

  // ── 7. fetch context ───────────────────────────────────────────────────────
  if (!isAllowedFetchContext(header(req, 'sec-fetch-mode'), header(req, 'sec-fetch-dest'))) {
    sendError(res, 403, 'forbidden_context', 'this endpoint only answers script-initiated requests', cors);
    return;
  }

  // ── 8. rate limiting ───────────────────────────────────────────────────────
  // Two buckets, so a hostile page flooding 127.0.0.1 exhausts only its own and
  // can never lock the user's paired extension out.
  const paired = verdict.origin !== undefined && isAllowedOrigin(verdict.origin, state.allowedOrigins());
  const bucket: BucketName = paired || route.auth === 'admin' ? 'paired' : 'anon';

  if (state.buckets.overCeiling()) {
    sendError(res, 429, 'rate_limited', 'too many requests', { 'retry-after': '5', ...cors });
    return;
  }
  if (state.buckets.throttled(bucket)) {
    sendError(res, 429, 'rate_limited', 'too many failed attempts', {
      'retry-after': String(state.buckets.retryAfterSec(bucket)),
      ...cors,
    });
    return;
  }

  // ── 9. auth ────────────────────────────────────────────────────────────────
  const ctx: RequestContext = { state, origin: verdict.origin, cors };
  if (route.auth !== 'none') {
    // Never from the query string: URLs land in logs, history and Referer.
    const token = bearer(req);
    const cfg = state.config();
    if (!token) {
      state.buckets.fail(bucket);
      sendError(res, 401, 'unauthorized', 'missing bearer token', cors);
      return;
    }
    if (route.auth === 'admin') {
      // adminToken is stored RAW (the CLI has to present it), so hash it here
      // to get the digest-vs-digest comparison tokenMatches is built around.
      if (!tokenMatches(token, hashToken(cfg.adminToken))) {
        state.buckets.fail(bucket);
        sendError(res, 401, 'unauthorized', 'bad admin token', cors);
        return;
      }
    } else {
      // The token must belong to the client that pinned THIS origin. A token
      // exfiltrated to a web page is therefore useless: gate 5 already rejected
      // the page's origin, and here it would not match the client either.
      const client = cfg.clients.find((c) => c.origin === verdict.origin && tokenMatches(token, c.tokenHash));
      if (!client) {
        state.buckets.fail(bucket);
        sendError(res, 401, 'unauthorized', 'bad token for this origin', cors);
        return;
      }
      // A pairing is only valid for the workspace `nff-brain serve` was bound
      // to at pair time. Stop it and start a fresh one — a DIFFERENT project —
      // on the same port, and a stale token would otherwise go on silently
      // authenticating (and writing) into the wrong project's brain.json. 409,
      // not 401/403: the token itself is still good, it just needs a fresh
      // pairing for whichever workspace is live now — client.ts treats
      // 401/403 as "this pairing is dead forever," which is the wrong signal
      // here. A client minted before this field existed has no workspaceRoot
      // at all and always fails this check, forcing one safe re-pair.
      if (client.workspaceRoot !== state.opts.workspaceRoot) {
        state.buckets.fail(bucket);
        sendError(res, 409, 'workspace_mismatch', 'this server now serves a different project — re-pair to continue', cors);
        return;
      }
      ctx.client = client;
    }
    state.buckets.succeed(bucket);
  }

  // ── 10. content type (bodies are capped inside readJsonBody) ───────────────
  if (method === 'POST') {
    const ct = header(req, 'content-type') ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      // Rejecting anything else is what stops an HTML <form> CSRF: a form can
      // only ever send urlencoded, multipart or text/plain.
      sendError(res, 415, 'unsupported_media_type', 'send application/json', cors);
      return;
    }
  }

  try {
    await route.handler(req, res, ctx);
  } catch (err) {
    if (err instanceof BodyError) {
      if (err.code === 'payload_too_large') {
        sendError(res, 413, 'payload_too_large', 'request body is too large', cors);
      } else {
        sendError(res, 400, 'bad_request', 'malformed JSON body', cors);
      }
      return;
    }
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: 'bad_request', message: 'internal error' }, cors);
    }
  }
}
