// /v1/mcp/* — a read-only-to-the-extension surface over registered MCP
// servers. Registering a server (packages/cli/src/commands/mcp.ts) is a
// local CLI-only concern; these routes only ever LIST what's already
// registered and CALL an already-registered tool. `headers` (where a bearer
// token or an X-Admin-Data-Secret lives) is never echoed back.

import {
  callMcpTool,
  listMcpTools,
  loadMcpServers,
  removeMcpServer,
  saveMcpServers,
  setMcpServerEnabled,
  type McpToolDef,
} from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

const MCP_CALL_BODY_MAX = 8 * 1024;
const MCP_TOOLS_CACHE_MS = 10_000;

const toolsCache = new Map<string, { at: number; tools: McpToolDef[] }>();

const mcpServersRoute: Handler = (_req, res, ctx) => {
  const servers = loadMcpServers().map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
  sendJson(res, 200, { ok: true, servers }, ctx.cors);
};

const mcpTools: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const serverId = url.searchParams.get('server') ?? '';
  const server = loadMcpServers().find((s) => s.id === serverId);
  if (!server) {
    sendError(res, 400, 'bad_request', 'unknown server id', ctx.cors);
    return;
  }

  const hit = toolsCache.get(server.id);
  const now = Date.now();
  if (hit && now - hit.at < MCP_TOOLS_CACHE_MS) {
    sendJson(res, 200, { ok: true, tools: hit.tools }, ctx.cors);
    return;
  }

  try {
    const tools = await listMcpTools(server);
    toolsCache.set(server.id, { at: now, tools });
    sendJson(res, 200, { ok: true, tools }, ctx.cors);
  } catch (err) {
    sendError(res, 502, 'mcp_error', err instanceof Error ? err.message : String(err), ctx.cors);
  }
};

const mcpCall: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, MCP_CALL_BODY_MAX)) as { server?: unknown; tool?: unknown; args?: unknown };
  const serverId = typeof body?.server === 'string' ? body.server : '';
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  const server = loadMcpServers().find((s) => s.id === serverId);
  if (!server || !tool) {
    sendError(res, 400, 'bad_request', 'a known server id and tool name are required', ctx.cors);
    return;
  }

  const args = body?.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
  const result = await callMcpTool(server, tool, args);
  if (!result.ok) {
    sendError(res, 502, 'mcp_error', result.error, ctx.cors);
    return;
  }
  sendJson(res, 200, { ok: true, result: result.content }, ctx.cors);
};

const MCP_MUTATE_BODY_MAX = 1 * 1024;

/**
 * Browser-mutable (the MCP tab): enable/disable an ALREADY-registered server.
 * Deliberately narrow — this never touches url/headers, so a compromised or
 * malicious page can silence or resume a server, never plant credentials.
 * Registering a NEW server stays CLI-only (`nff-brain mcp add`).
 */
const mcpServersEnable: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, MCP_MUTATE_BODY_MAX)) as { id?: unknown; enabled?: unknown };
  const id = typeof body?.id === 'string' ? body.id : '';
  const servers = loadMcpServers();
  if (!id || !servers.some((s) => s.id === id)) {
    sendError(res, 400, 'bad_request', 'unknown server id', ctx.cors);
    return;
  }
  const next = setMcpServerEnabled(servers, id, body.enabled === true);
  saveMcpServers(next);
  sendJson(res, 200, { ok: true, servers: next.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled })) }, ctx.cors);
};

const mcpServersRemove: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, MCP_MUTATE_BODY_MAX)) as { id?: unknown };
  const id = typeof body?.id === 'string' ? body.id : '';
  const servers = loadMcpServers();
  if (!id || !servers.some((s) => s.id === id)) {
    sendError(res, 400, 'bad_request', 'unknown server id', ctx.cors);
    return;
  }
  const next = removeMcpServer(servers, id);
  saveMcpServers(next);
  sendJson(res, 200, { ok: true, servers: next.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled })) }, ctx.cors);
};

export const MCP_ROUTES: Record<string, Route> = {
  '/v1/mcp/servers': { method: 'GET', auth: 'client', origin: 'paired', handler: mcpServersRoute },
  '/v1/mcp/servers/enable': { method: 'POST', auth: 'client', origin: 'paired', handler: mcpServersEnable },
  '/v1/mcp/servers/remove': { method: 'POST', auth: 'client', origin: 'paired', handler: mcpServersRemove },
  '/v1/mcp/tools': { method: 'GET', auth: 'client', origin: 'paired', handler: mcpTools },
  '/v1/mcp/call': { method: 'POST', auth: 'client', origin: 'paired', handler: mcpCall },
};
