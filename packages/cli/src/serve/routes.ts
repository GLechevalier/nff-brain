// The /v1 surface. Paths are looked up in a STATIC table — there is no path
// arithmetic and nothing here ever maps a request onto the filesystem, so path
// traversal is not a category of bug this server can have.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MAX_CLIPS_BYTES,
  SERVE_PROTOCOL,
  addClient,
  appendClip,
  compactClipMap,
  findClientById,
  fuseRanked,
  helloProof,
  mutateBrain,
  readClipMap,
  removeClient,
  removeNode,
  verifyPairingCode,
} from '@nff-brain/core';
import type { CaptureTarget, ServeClient } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { ServeState } from './state.js';
import { AGENT_ROUTES } from './agentRoutes.js';
import { IMPORT_ROUTES } from './importRoutes.js';
import { MCP_ROUTES } from './mcpRoutes.js';
import { CHAT_ROUTES } from './chatRoutes.js';

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

// ── GET /v1/nodes + /v1/search (the DevTools Brain panel) ────────────────────

const NODES_LIMIT_DEFAULT = 20;
const NODES_LIMIT_MAX = 100;
const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_Q_MAX = 256;
const EXCERPT_MAX = 240;
const MAX_RELATED = 3;

function clampLimit(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

function excerpt(content: string | undefined): string {
  const t = (content ?? '').replace(/\s+/g, ' ').trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1)}…` : t;
}

/**
 * Node counts + recent nodes for the panel header and its idle view. Read-only
 * over the merged (project-wins) snapshot, same semantics as recall.
 */
const nodes: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const limit = clampLimit(url.searchParams.get('limit'), NODES_LIMIT_DEFAULT, NODES_LIMIT_MAX);
  const { state } = ctx;
  const merged = state.mergedBrain();

  const recent = [...merged.nodes]
    .sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : a.lastUpdated > b.lastUpdated ? -1 : 0))
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      title: n.title,
      category: n.category,
      origin: n.origin,
      source: merged.sourceById.get(n.id) ?? 'global',
      lastUpdated: n.lastUpdated,
      excerpt: excerpt(n.content),
    }));

  const ws = state.summarize(state.opts.projectBrainPath);
  const gl = state.summarize(state.opts.globalBrainPath);
  sendJson(
    res,
    200,
    {
      ok: true,
      updatedAt: state.latestUpdatedAt(),
      merged: { nodes: merged.nodes.length, edges: merged.edges.length },
      workspace: {
        name: state.opts.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
        nodes: ws.nodes,
        edges: ws.edges,
      },
      global: { nodes: gl.nodes, edges: gl.edges },
      recent,
    },
    ctx.cors,
  );
};

/**
 * The full node/edge set with GEOMETRY — for the panel's Graph tab canvas.
 * Deliberately not capped like `nodes`' `recent` list: a graph with a hole in
 * it is worse than a slightly bigger payload for what's realistically a few
 * hundred nodes. Positions/size/color are whatever `nff-brain layout` last
 * computed and stored — this route only ever reads them, never computes.
 */
const graph: Handler = (_req, res, ctx) => {
  const merged = ctx.state.mergedBrain();
  sendJson(
    res,
    200,
    {
      ok: true,
      nodes: merged.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        category: n.category,
        origin: n.origin,
        x: n.x,
        y: n.y,
        size: n.size,
        color: n.color,
      })),
      edges: merged.edges.map((e) => ({ from: e.from, to: e.to, strength: e.strength })),
    },
    ctx.cors,
  );
};

/**
 * Ranked retrieval for the panel's Search tab AND its Ask tab (item 5 is this
 * same response rendered conversationally — retrieval-only, no LLM). Lexical
 * ranking only: the semantic runtime (model download, embedding cache) stays
 * out of the serve request path by design. `score` is the fused scale — the UI
 * must render rank order, never the absolute number, so enabling semantic
 * fusion later is shape-compatible.
 */
const search: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, SEARCH_Q_MAX);
  const limit = clampLimit(url.searchParams.get('limit'), SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  if (!q) {
    // As-you-type friendly: an empty box is an empty result, not an error.
    sendJson(res, 200, { ok: true, q: '', count: 0, hits: [] }, ctx.cors);
    return;
  }

  const merged = ctx.state.mergedBrain();
  const titleById = new Map(merged.nodes.map((n) => [n.id, n.title]));
  const ranked = fuseRanked(q, merged.nodes, null, { limit });

  const hits = ranked.map((r) => {
    const related = merged.edges
      .filter((e) => e.from === r.node.id || e.to === r.node.id)
      .map((e) => ({ id: e.from === r.node.id ? e.to : e.from, strength: e.strength }))
      .filter((e) => titleById.has(e.id))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_RELATED)
      .map((e) => ({ id: e.id, title: titleById.get(e.id)!, strength: e.strength }));
    return {
      id: r.node.id,
      title: r.node.title,
      category: r.node.category,
      origin: r.node.origin,
      source: merged.sourceById.get(r.node.id) ?? 'global',
      lastUpdated: r.node.lastUpdated,
      score: r.fused,
      excerpt: excerpt(r.node.content),
      related,
    };
  });

  sendJson(res, 200, { ok: true, q, count: hits.length, hits }, ctx.cors);
};

// ── GET /v1/clips/map ────────────────────────────────────────────────────────

/** Both brains — a clip's node lands wherever the clip's target routed it. */
function brainPaths(state: ServeState): string[] {
  const { projectBrainPath, globalBrainPath } = state.opts;
  return projectBrainPath === globalBrainPath ? [globalBrainPath] : [globalBrainPath, projectBrainPath];
}

/**
 * The drain's clip→node ledger, filtered to the REQUESTING client's own clips.
 * This is how the extension fills ActivityRecord.nodeIds, which is what makes
 * the popup's "also remove nodes created from this activity" checkbox real.
 */
const clipsMap: Handler = (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const since = url.searchParams.get('since') ?? undefined;
  const clientId = ctx.client!.id;
  const map = brainPaths(ctx.state)
    .flatMap((p) => readClipMap(p, { clientId, since }))
    .map((e) => ({ clipId: e.clipId, nodeIds: e.nodeIds, at: e.at }));
  sendJson(res, 200, { ok: true, map }, ctx.cors);
};

// ── POST /v1/retract ─────────────────────────────────────────────────────────

const RETRACT_MAX_IDS = 200;

/**
 * Delete clip nodes at the extension's request ("clear activity history, also
 * remove nodes"). Three INDEPENDENT gates per node, each load-bearing:
 *   1. it was requested by id;
 *   2. origin === 'clip' — the hard security line: the extension can never
 *      delete agent/seed/import knowledge, even via a poisoned ledger;
 *   3. the requesting client's own clips created it — one paired browser
 *      cannot delete another's.
 * Ids that fail a gate (or were already evicted by pruneClips) are silently
 * absent from `removed`; the extension reconciles against that list.
 */
const retract: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, CLIP_BODY_MAX)) as { nodeIds?: unknown };
  const requested = Array.isArray(body?.nodeIds)
    ? body.nodeIds.filter((v): v is string => typeof v === 'string').slice(0, RETRACT_MAX_IDS)
    : [];
  if (requested.length === 0) {
    sendJson(res, 200, { ok: true, removed: [] }, ctx.cors);
    return;
  }

  const clientId = ctx.client!.id;
  const removed: string[] = [];
  for (const brainPath of brainPaths(ctx.state)) {
    const attributed = new Set(readClipMap(brainPath, { clientId }).flatMap((e) => e.nodeIds));
    const candidates = requested.filter((id) => attributed.has(id));
    if (candidates.length === 0) continue;

    const removedHere = mutateBrain(brainPath, (brain) => {
      const out: string[] = [];
      for (const id of candidates) {
        const node = brain.nodes.find((n) => n.id === id);
        if (node && node.origin === 'clip' && removeNode(brain, id)) out.push(id);
      }
      return out;
    });
    if (removedHere.length > 0) {
      compactClipMap(brainPath, { dropNodeIds: new Set(removedHere) });
      removed.push(...removedHere);
    }
  }
  sendJson(res, 200, { ok: true, removed }, ctx.cors);
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
  '/v1/clips/map': { method: 'GET', auth: 'client', origin: 'paired', handler: clipsMap },
  '/v1/retract': { method: 'POST', auth: 'client', origin: 'paired', handler: retract },
  '/v1/nodes': { method: 'GET', auth: 'client', origin: 'paired', handler: nodes },
  '/v1/graph': { method: 'GET', auth: 'client', origin: 'paired', handler: graph },
  '/v1/search': { method: 'GET', auth: 'client', origin: 'paired', handler: search },
  '/v1/admin/pair-window': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminPairWindow },
  '/v1/admin/clients': { method: 'GET', auth: 'admin', origin: 'absent', handler: adminClients },
  '/v1/admin/revoke': { method: 'POST', auth: 'admin', origin: 'absent', handler: adminRevoke },
  ...AGENT_ROUTES,
  ...IMPORT_ROUTES,
  ...MCP_ROUTES,
  ...CHAT_ROUTES,
};
