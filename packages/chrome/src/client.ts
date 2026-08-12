// The HTTP client. Every URL it can possibly build points at 127.0.0.1 — the
// manifest's `connect-src 'self' http://127.0.0.1:*` makes Chrome enforce that
// too, and bundlePurity.test.ts asserts no other origin appears in the bundle.

import {
  HOST,
  REQUEST_TIMEOUT_MS,
  isAgentGoalResponse,
  isAgentNextActionResponse,
  isAgentStatusResponse,
  isClipsMapResponse,
  isHelloResponse,
  isMcpServersResponse,
  isMcpToolsResponse,
  isNodesResponse,
  isPairResponse,
  isRetractResponse,
  isSearchResponse,
  isStatusResponse,
} from './protocol.js';
import type {
  AgentCardResult,
  AgentGoalResponse,
  AgentNextActionResponse,
  AgentStatusResponse,
  ClipResponse,
  ClipsMapResponse,
  HelloResponse,
  McpServersResponse,
  McpToolsResponse,
  NodesResponse,
  PairResponse,
  RetractResponse,
  SearchResponse,
  StatusResponse,
  WebAgentListTarget,
  WebAgentVerb,
} from './protocol.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** 401/403 mean the pairing is dead — retrying forever is pointless. */
  get rejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function url(port: number, path: string): string {
  return `http://${HOST}:${port}${path}`;
}

async function call(port: number, path: string, init: RequestInit & { token?: string } = {}): Promise<unknown> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url(port, path), {
      ...rest,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...rest.headers,
      },
      // A hung fetch in a service worker is a bad failure mode: it keeps the
      // worker alive burning nothing useful and it makes the popup hang.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new HttpError(0, 'network', name === 'TimeoutError' ? 'the brain did not answer in time' : 'no brain listening');
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new HttpError(res.status, body.error ?? String(res.status), body.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function hello(port: number, params?: { nonce: string; clientId: string }): Promise<HelloResponse> {
  const qs = params ? `?nonce=${encodeURIComponent(params.nonce)}&client=${encodeURIComponent(params.clientId)}` : '';
  const body = await call(port, `/v1/hello${qs}`);
  if (!isHelloResponse(body)) throw new HttpError(0, 'protocol', 'that port is not an nff-brain server');
  return body;
}

export async function pair(port: number, code: string): Promise<PairResponse> {
  const body = await call(port, '/v1/pair', {
    method: 'POST',
    body: JSON.stringify({ code, client: { name: 'Chrome extension' } }),
  });
  if (!isPairResponse(body)) throw new HttpError(0, 'protocol', 'unexpected pairing response');
  return body;
}

export async function status(port: number, token: string): Promise<StatusResponse> {
  const body = await call(port, '/v1/status', { token });
  // A malformed body is a DISCONNECT, not a connection reporting zero nodes:
  // "0 nodes" is a real and alarming state and must not be manufacturable by a
  // truncated response.
  if (!isStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected status response');
  return body;
}

export interface ClipPayload {
  kind: 'selection' | 'link' | 'page' | 'note';
  text: string;
  url?: string;
  title?: string;
  capturedAt: string;
}

export async function postClip(port: number, token: string, clip: ClipPayload): Promise<ClipResponse> {
  return (await call(port, '/v1/clip', { method: 'POST', token, body: JSON.stringify(clip) })) as ClipResponse;
}

/** Node counts + recent nodes for the DevTools Brain panel. */
export async function getNodes(port: number, token: string, limit?: number): Promise<NodesResponse> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const body = await call(port, `/v1/nodes${qs}`, { token });
  if (!isNodesResponse(body)) throw new HttpError(0, 'protocol', 'unexpected nodes response');
  return body;
}

/** Ranked retrieval — powers both the panel's Search tab and its Ask tab. */
export async function searchBrain(port: number, token: string, q: string, limit?: number): Promise<SearchResponse> {
  const qs = `?q=${encodeURIComponent(q)}${limit ? `&limit=${encodeURIComponent(String(limit))}` : ''}`;
  const body = await call(port, `/v1/search${qs}`, { token });
  if (!isSearchResponse(body)) throw new HttpError(0, 'protocol', 'unexpected search response');
  return body;
}

/** The drain's clip→node ledger, filtered server-side to OUR clips. */
export async function getClipsMap(port: number, token: string, since?: string): Promise<ClipsMapResponse> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const body = await call(port, `/v1/clips/map${qs}`, { token });
  if (!isClipsMapResponse(body)) throw new HttpError(0, 'protocol', 'unexpected clips-map response');
  return body;
}

/** Ask the server to delete clip nodes our captures created. */
export async function retract(port: number, token: string, nodeIds: string[]): Promise<RetractResponse> {
  const body = await call(port, '/v1/retract', { method: 'POST', token, body: JSON.stringify({ nodeIds }) });
  if (!isRetractResponse(body)) throw new HttpError(0, 'protocol', 'unexpected retract response');
  return body;
}

// ── web agent (item 7) ────────────────────────────────────────────────────────

export async function submitAgentGoal(
  port: number,
  token: string,
  params: { goal: string; maxActions: number; listTarget: WebAgentListTarget | null },
): Promise<AgentGoalResponse> {
  const body = await call(port, '/v1/agent/goal', { method: 'POST', token, body: JSON.stringify(params) });
  if (!isAgentGoalResponse(body)) throw new HttpError(0, 'protocol', 'unexpected goal response');
  return body;
}

export async function getAgentStatus(port: number, token: string): Promise<AgentStatusResponse> {
  const body = await call(port, '/v1/agent/status', { token });
  if (!isAgentStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected agent status response');
  return body;
}

export async function approveAgentPlan(port: number, token: string, runId: string): Promise<AgentStatusResponse> {
  const body = await call(port, '/v1/agent/plan/approve', { method: 'POST', token, body: JSON.stringify({ runId }) });
  if (!isAgentStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected agent status response');
  return body;
}

export async function rejectAgentPlan(port: number, token: string, runId: string): Promise<AgentStatusResponse> {
  const body = await call(port, '/v1/agent/plan/reject', { method: 'POST', token, body: JSON.stringify({ runId }) });
  if (!isAgentStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected agent status response');
  return body;
}

/** Idempotent server-side — never throws on an already-terminal or unknown run. */
export async function stopAgentRun(port: number, token: string, runId: string): Promise<void> {
  await call(port, '/v1/agent/stop', { method: 'POST', token, body: JSON.stringify({ runId }) });
}

export async function getAgentNextAction(port: number, token: string): Promise<AgentNextActionResponse> {
  const body = await call(port, '/v1/agent/next-action', { token });
  if (!isAgentNextActionResponse(body)) throw new HttpError(0, 'protocol', 'unexpected next-action response');
  return body;
}

export interface ReportAgentActionParams {
  runId: string;
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
  result: {
    ok: boolean;
    summary: string;
    fields?: Record<string, string>;
    cards?: AgentCardResult[];
  };
}

export async function reportAgentAction(
  port: number,
  token: string,
  params: ReportAgentActionParams,
): Promise<AgentStatusResponse> {
  const body = await call(port, '/v1/agent/action-result', { method: 'POST', token, body: JSON.stringify(params) });
  if (!isAgentStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected agent status response');
  return body;
}

// ── MCP servers (item 7) ────────────────────────────────────────────────────

export async function getMcpServers(port: number, token: string): Promise<McpServersResponse> {
  const body = await call(port, '/v1/mcp/servers', { token });
  if (!isMcpServersResponse(body)) throw new HttpError(0, 'protocol', 'unexpected mcp servers response');
  return body;
}

export async function getMcpTools(port: number, token: string, serverId: string): Promise<McpToolsResponse> {
  const body = await call(port, `/v1/mcp/tools?server=${encodeURIComponent(serverId)}`, { token });
  if (!isMcpToolsResponse(body)) throw new HttpError(0, 'protocol', 'unexpected mcp tools response');
  return body;
}

/**
 * Confirm a port is OUR server before sending it a bearer token.
 *
 * The extension walks a small port range, so without this a hostile local
 * process squatting a neighbouring port would harvest the token on the first
 * request. The server proves it holds our token's hash by HMACing a nonce with
 * it; we recompute the same value from the token we already have.
 */
export async function verifyProof(port: number, token: string, clientId: string): Promise<boolean> {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  let res: HelloResponse;
  try {
    res = await hello(port, { nonce, clientId });
  } catch {
    return false;
  }
  if (!res.proof) return false;
  return res.proof === (await helloProof(token, nonce));
}

/** HMAC-SHA256(key = SHA-256(token), "nff-brain-hello-v1:" + nonce), hex. */
async function helloProof(token: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(token));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`nff-brain-hello-v1:${nonce}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
