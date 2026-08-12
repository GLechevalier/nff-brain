// Minimal, hand-rolled MCP-over-HTTP client — deliberately NOT
// `@modelcontextprotocol/sdk`. That SDK's client transport is real and
// importable standalone, but its package.json pulls the whole SDK's
// dependency tree regardless of subpath (express, hono, cross-spawn, ajv,
// jose, zod, ~16 packages) — adding it would be this CLI's first runtime
// dependency ever, breaking the documented "zero-runtime-dependency tarball"
// property (see serve/http.ts's own comment on the same constraint).
//
// Scope: the stateless flavor of MCP's Streamable HTTP transport only — one
// JSON-RPC POST in, one response out (either a plain `application/json` body
// or a single-frame `text/event-stream`), no `Mcp-Session-Id` handshake, no
// live SSE stream to read. This is proportionate to what's actually needed:
// nff-admin-data's own MCP endpoint (the first real target) is configured
// exactly this way (`sessionIdGenerator: undefined, enableJsonResponse: true`).
// A server that requires a stateful session or a live SSE stream is out of
// scope for v1 and fails with a clear error here, not a silent hang.
//
// No `initialize` handshake is sent before tools/list or tools/call: a
// genuinely stateless server (the documented target case) does not require
// one, and this client never straddles two calls with a preserved session
// (each call is one self-contained POST) — an `initialize`-then-forget on a
// FRESH per-request server instance would not accomplish anything.

import { randomBytes } from 'node:crypto';

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  /** Where a per-server secret (bearer token, X-Admin-Data-Secret, ...) lives. */
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpCallResult = { ok: true; content: unknown } | { ok: false; error: string };

const MCP_REQUEST_TIMEOUT_MS = 15_000;

function jsonRpcId(): number {
  return randomBytes(4).readUInt32BE(0);
}

function parseSseFrame(text: string): unknown {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      // keep scanning — a real data frame may follow a comment/heartbeat line
    }
  }
  throw new Error(
    'MCP server returned an SSE stream with no parseable data frame — stateful/streaming transports are not supported',
  );
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function postJsonRpc(server: McpServerConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...server.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: jsonRpcId(), method, params }),
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach MCP server "${server.name}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP server "${server.name}" replied ${res.status}: ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  let body: unknown;
  try {
    body = contentType.includes('text/event-stream') ? parseSseFrame(text) : JSON.parse(text);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('MCP server returned an SSE')) throw err;
    throw new Error(`MCP server "${server.name}" returned an unparseable ${contentType || 'response'}`);
  }

  const rpc = body as JsonRpcEnvelope;
  if (rpc && typeof rpc === 'object' && rpc.error) {
    throw new Error(rpc.error.message ?? `MCP server "${server.name}" returned an error`);
  }
  return rpc?.result;
}

export async function listMcpTools(server: McpServerConfig): Promise<McpToolDef[]> {
  const result = await postJsonRpc(server, 'tools/list', {});
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  const out: McpToolDef[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const def = t as Partial<McpToolDef>;
    if (typeof def.name !== 'string') continue;
    out.push({
      name: def.name,
      description: typeof def.description === 'string' ? def.description : undefined,
      inputSchema:
        def.inputSchema && typeof def.inputSchema === 'object' ? (def.inputSchema as Record<string, unknown>) : {},
    });
  }
  return out;
}

function summarizeToolContent(content: unknown): string {
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
    ) as { text?: unknown } | undefined;
    if (textBlock && typeof textBlock.text === 'string') return textBlock.text.slice(0, 500);
  }
  return 'MCP tool call failed';
}

export async function callMcpTool(
  server: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    const result = await postJsonRpc(server, 'tools/call', { name: tool, arguments: args });
    const r = result as { content?: unknown; isError?: boolean } | undefined;
    if (r?.isError) return { ok: false, error: summarizeToolContent(r.content) };
    return { ok: true, content: r?.content ?? result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Connectivity/capability check used by `nff-brain mcp test` — never throws. */
export async function pingMcpServer(
  server: McpServerConfig,
): Promise<{ ok: true; toolCount: number; tools: McpToolDef[] } | { ok: false; error: string }> {
  try {
    const tools = await listMcpTools(server);
    return { ok: true, toolCount: tools.length, tools };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
