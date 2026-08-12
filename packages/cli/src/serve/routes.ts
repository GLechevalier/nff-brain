// The /v1 surface. Paths are looked up in a STATIC table — there is no path
// arithmetic and nothing here ever maps a request onto the filesystem, so path
// traversal is not a category of bug this server can have.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_CLIPS_BYTES,
  SERVE_PROTOCOL,
  addClient,
  appendClip,
  findClientById,
  helloProof,
  removeClient,
  verifyPairingCode,
} from '@nff-brain/core';
import type { CaptureTarget, ServeClient } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { ServeState } from './state.js';

const PAIR_BODY_MAX = 8 * 1024;
const CLIP_BODY_MAX = 64 * 1024;

export type AuthLevel = 'none' | 'client' | 'admin';

/**
 * - `paired`   Origin must be present and belong to a paired client.
 * - `extension` Origin must be present and look like a Chrome extension. Used
 *               by /pair, where the origin is not yet known — it is pinned there.
 * - `lenient`  Origin may be absent (the CLI's own probe, curl); if present it
 *              must still be an extension or allowlisted origin.
 * - `absent`   Origin must NOT be present. Admin routes: no browser, ever.
 */
export type OriginPolicy = 'paired' | 'extension' | 'lenient' | 'absent';

export interface RequestContext {
  state: ServeState;
  /** Present only when an Origin header was sent AND accepted. */
  origin?: string;
  /** Set for auth === 'client'. */
  client?: ServeClient;
  /** CORS headers to merge into the response, when an origin was accepted. */
  cors: Record<string, string>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: 'GET' | 'POST';
  auth: AuthLevel;
  origin: OriginPolicy;
  handler: Handler;
}

// ── GET /v1/hello ────────────────────────────────────────────────────────────

/**
 * Unauthenticated discovery. Deliberately leaks NOTHING: no paths, no node
 * counts, no token. `proof` lets a client that already holds a token confirm
 * this port is really its own server BEFORE sending the token anywhere — the
 * extension walks a small port range, so without it a local squatter on a
 * neighbouring port would harvest the bearer on the first request.
 */
const hello: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const nonce = url.searchParams.get('nonce');
  const clientId = url.searchParams.get('client');
  const cfg = ctx.state.config();

  const body: Record<string, unknown> = {
    ok: true,
    name: 'nff-brain',
    protocol: SERVE_PROTOCOL,
    version: ctx.state.opts.cliVersion,
    serverId: cfg.serverId,
    paired: cfg.clients.length > 0,
    pairing: ctx.state.pairing !== null && !ctx.state.pairing.consumed,
  };

  if (nonce && clientId) {
    const client = findClientById(cfg, clientId);
    if (client) body.proof = helloProof(client.tokenHash, nonce);
  }
  sendJson(res, 200, body, ctx.cors);
};

// ── POST /v1/pair ────────────────────────────────────────────────────────────

const pair: Handler = async (req, res, ctx) => {
  const { state } = ctx;
  const origin = ctx.origin!; // guaranteed by the 'extension' origin policy

  if (!state.pairing) {
    sendError(res, 403, 'pairing_closed', 'no pairing window is open — run `nff-brain pair`', ctx.cors);
    return;
  }

  const body = (await readJsonBody(req, PAIR_BODY_MAX)) as { code?: unknown; client?: { name?: unknown } };
  const code = typeof body?.code === 'string' ? body.code : '';
  const result = verifyPairingCode(state.pairing, code, Date.now());
  state.pairing = result.window;

  if (result.verdict !== 'ok') {
    if (result.verdict === 'bad_code') {
      const left = result.window.attemptsLeft;
      sendError(
        res,
        403,
        left > 0 ? 'bad_code' : 'pairing_closed',
        left > 0
          ? `wrong code — ${left} attempt${left === 1 ? '' : 's'} left`
          : 'too many wrong codes — the window is closed, run `nff-brain pair`',
        ctx.cors,
      );
      return;
    }
    sendError(
      res,
      403,
      'pairing_closed',
      result.verdict === 'expired' ? 'the pairing window expired — run `nff-brain pair`' : 'the pairing window is closed',
      ctx.cors,
    );
    return;
  }

  const cfg = state.config();
  const name = typeof body?.client?.name === 'string' ? body.client.name : 'Chrome extension';
  // THE ORIGIN IS PINNED HERE. Every later request from this client must match
  // it exactly — which is what stops any OTHER installed extension, each of
  // which can also fetch 127.0.0.1 from its own service worker.
  const { client, token } = addClient(cfg, { name, origin });
  state.saveConfig(cfg);

  sendJson(res, 200, { ok: true, token, clientId: client.id, serverId: cfg.serverId, origin }, ctx.cors);
};

// ── GET /v1/status ───────────────────────────────────────────────────────────

const status: Handler = (_req, res, ctx) => {
  const { state } = ctx;
  const cfg = state.config();
  const target = cfg.capture.defaultTarget;
  const queue = state.queueStats(target);

  sendJson(
    res,
    200,
    {
      ok: true,
      protocol: SERVE_PROTOCOL,
      version: state.opts.cliVersion,
      serverId: cfg.serverId,
      startedAt: state.startedAt,
      port: state.port,
      workspace: {
        root: state.opts.workspaceRoot,
        name: state.opts.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
        ...state.summarize(state.opts.projectBrainPath),
      },
      global: state.summarize(state.opts.globalBrainPath),
      merged: state.mergedCounts(),
      capture: { defaultTarget: target },
      queue: {
        path: queue.path,
        pending: queue.pending,
        bytes: queue.bytes,
        full: queue.full,
        maxBytes: MAX_CLIPS_BYTES,
      },
      client: ctx.client ? { id: ctx.client.id, name: ctx.client.name } : undefined,
    },
    ctx.cors,
  );
};

// ── POST /v1/clip ────────────────────────────────────────────────────────────

const clip: Handler = async (req, res, ctx) => {
  const { state } = ctx;
  const cfg = state.config();
  const body = (await readJsonBody(req, CLIP_BODY_MAX)) as Record<string, unknown>;

  const target: CaptureTarget = body?.target === 'project' ? 'project' : body?.target === 'global' ? 'global' : cfg.capture.defaultTarget;
  const brainPath = state.targetBrainPath(target);

  const result = appendClip(brainPath, body ?? {}, {
    target,
    source: 'chrome',
    workspaceRoot: state.opts.workspaceRoot,
    clientId: ctx.client?.id,
  });

  if (!result.ok) {
    if (result.reason === 'queue_full') {
      // 507 rather than a rotate-and-forget: a clip is user intent that has not
      // landed in the brain yet, so dropping it silently is the worst option.
      sendError(res, 507, 'queue_full', 'the clip queue is full — start a Claude Code session to drain it', ctx.cors);
      return;
    }
    if (result.reason === 'too_large') {
      sendError(res, 413, 'payload_too_large', 'that selection is too large to store as one clip', ctx.cors);
      return;
    }
    sendError(res, 400, 'bad_request', 'a clip needs a known kind and some text or a http(s) url', ctx.cors);
    return;
  }

  sendJson(res, 201, { ok: true, id: result.id, target, pending: result.pending }, ctx.cors);
};

// ── admin (loopback + adminToken; unreachable from any browser) ───────────────

const adminPairWindow: Handler = (_req, res, ctx) => {
  const code = ctx.state.openPairing();
  sendJson(res, 200, { ok: true, code, expiresAt: new Date(ctx.state.pairing!.expiresAtMs).toISOString() });
};

const adminClients: Handler = (_req, res, ctx) => {
  const cfg = ctx.state.config();
  sendJson(res, 200, {
    ok: true,
    clients: cfg.clients.map((c) => ({
      id: c.id,
      name: c.name,
      origin: c.origin,
      createdAt: c.createdAt,
    })),
  });
};

const adminRevoke: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, PAIR_BODY_MAX)) as { id?: unknown };
  const cfg = ctx.state.config();
  const removed = typeof body?.id === 'string' ? removeClient(cfg, body.id) : false;
  if (removed) ctx.state.saveConfig(cfg);
  sendJson(res, 200, { ok: true, removed });
};

export const ROUTES: Record<string, Route> = {
  '/v1/hello': { method: 'GET', auth: 'none', origin: 'lenient', handler: hello },
  '/v1/pair': { method: 'POST', auth: 'none', origin: 'extension', handler: pair },
  '/v1/status': { method: 'GET', auth: 'client', origin: 'paired', handler: status },
  '/v1/clip': { method: 'POST', auth: 'client', origin: 'paired', handler: clip },
  '/v1/admin/pair-window': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminPairWindow },
  '/v1/admin/clients': { method: 'GET', auth: 'admin', origin: 'absent', handler: adminClients },
  '/v1/admin/revoke': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminRevoke },
};
