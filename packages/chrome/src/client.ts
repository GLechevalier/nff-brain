// The HTTP client. Every URL it can possibly build points at 127.0.0.1 — the
// manifest's `connect-src 'self' http://127.0.0.1:*` makes Chrome enforce that
// too, and bundlePurity.test.ts asserts no other origin appears in the bundle.

import {
  CHAT_TIMEOUT_MS,
  HOST,
  REQUEST_TIMEOUT_MS,
  isAgentGoalResponse,
  isAgentNextActionResponse,
  isAgentStatusResponse,
  isChatResponse,
  isClipsMapResponse,
  isExportResponse,
  isFlagsResponse,
  isGraphResponse,
  isHelloResponse,
  isImportResponse,
  isLayoutResponse,
  isMcpServersResponse,
  isMcpToolsResponse,
  isNodesResponse,
  isPairResponse,
  isRetractResponse,
  isSearchResponse,
  isStatusResponse,
  isTraceDistillResponse,
  isWorkflowSpecResponse,
  isWorkflowsResponse,
} from './protocol.js';
import type {
  AgentCardResult,
  AgentGoalResponse,
  AgentNextActionResponse,
  AgentStatusResponse,
  ChatResponse,
  ChatTurn,
  ClipResponse,
  ClipsMapResponse,
  ExportResponse,
  FlagsResponse,
  GraphResponse,
  HelloResponse,
  ImportResponse,
  LayoutResponse,
  McpServersResponse,
  McpToolsResponse,
  NodesResponse,
  PairResponse,
  RetractResponse,
  SearchResponse,
  StatusResponse,
  TraceDistillResponse,
  WebAgentListTarget,
  WebAgentVerb,
  WorkflowsResponse,
  WorkflowSpecResponse,
} from './protocol.js';
import type { TraceRecord } from '@nff-brain/core/trace';

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
  /**
   * 409 workspace_mismatch: the token is still good, but `nff-brain serve` is
   * now bound to a DIFFERENT project than the one this pairing was made for
   * (it was stopped and restarted against another workspace on the same
   * port). Distinct from `rejected` — the token isn't dead, and simply
   * switching back to the original workspace's server self-heals it, so the
   * caller must keep retrying rather than giving up.
   */
  get workspaceMismatch(): boolean {
    return this.status === 409 && this.code === 'workspace_mismatch';
  }
}

function url(port: number, path: string): string {
  return `http://${HOST}:${port}${path}`;
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { token?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const { token, timeoutMs, ...rest } = init;
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
      // Every call site gets the same short ceiling EXCEPT chat, which
      // genuinely needs to wait out a claude -p round trip (askChat passes
      // its own longer timeoutMs) — see CHAT_TIMEOUT_MS in protocol.ts.
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // 'timeout' and 'network' are distinct codes on purpose: a timeout means
    // the route exists and the server is just slow (retrying elsewhere is
    // wrong), while 'network' covers both "nothing listening" AND an old
    // server 404ing the CORS preflight for a route it predates — Chrome
    // reports that blocked preflight as the same opaque fetch failure, so a
    // version-skew fallback has to key off 'network' (see runPairedLoop).
    const name = (err as Error)?.name;
    if (name === 'TimeoutError') throw new HttpError(0, 'timeout', 'the brain did not answer in time');
    throw new HttpError(0, 'network', 'no brain listening');
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
  kind: 'selection' | 'link' | 'page' | 'note' | 'pagevisit';
  text: string;
  url?: string;
  title?: string;
  capturedAt: string;
}

export async function postClip(port: number, token: string, clip: ClipPayload): Promise<ClipResponse> {
  return (await call(port, '/v1/clip', { method: 'POST', token, body: JSON.stringify(clip) })) as ClipResponse;
}

export interface ImportPayload {
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ from: string; to: string; strength: number }>;
  map: Array<{ clipId: string; nodeIds: string[] }>;
}

/** Standalone→paired migration. A ~300 KB body + a synchronous server-side
 *  brain mutate outgrow the blanket 2.5s ceiling, hence the override. */
const IMPORT_TIMEOUT_MS = 15_000;

export async function postImport(port: number, token: string, payload: ImportPayload): Promise<ImportResponse> {
  const body = await call(port, '/v1/import', {
    method: 'POST',
    token,
    timeoutMs: IMPORT_TIMEOUT_MS,
    body: JSON.stringify(payload),
  });
  if (!isImportResponse(body)) throw new HttpError(0, 'protocol', 'unexpected import response');
  return body;
}

/** Node counts + recent nodes for the DevTools Brain panel. */
export async function getNodes(port: number, token: string, limit?: number): Promise<NodesResponse> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const body = await call(port, `/v1/nodes${qs}`, { token });
  if (!isNodesResponse(body)) throw new HttpError(0, 'protocol', 'unexpected nodes response');
  return body;
}

/** The full node/edge set with geometry, for the panel's Graph tab canvas. */
export async function getGraph(port: number, token: string): Promise<GraphResponse> {
  const body = await call(port, '/v1/graph', { token });
  if (!isGraphResponse(body)) throw new HttpError(0, 'protocol', 'unexpected graph response');
  return body;
}

/** The merged brain with FULL node content — seeds the local BYOK retrieval store. */
export async function getExport(port: number, token: string): Promise<ExportResponse> {
  const body = await call(port, '/v1/export', { token });
  if (!isExportResponse(body)) throw new HttpError(0, 'protocol', 'unexpected export response');
  return body;
}

/** Persist a node the reader dragged and dropped on the Graph tab canvas. */
export async function moveGraphNode(port: number, token: string, id: string, x: number, y: number): Promise<LayoutResponse> {
  const body = await call(port, '/v1/layout', { method: 'POST', token, body: JSON.stringify({ id, x, y }) });
  if (!isLayoutResponse(body)) throw new HttpError(0, 'protocol', 'unexpected layout response');
  return body;
}

/** Persist a node's company-sync flags (private / shared) on the server's brain. */
export async function setNodeFlags(
  port: number,
  token: string,
  id: string,
  flags: { private?: boolean; shared?: boolean },
): Promise<FlagsResponse> {
  const body = await call(port, '/v1/flags', { method: 'POST', token, body: JSON.stringify({ id, ...flags }) });
  if (!isFlagsResponse(body)) throw new HttpError(0, 'protocol', 'unexpected flags response');
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
  params: { goal: string; maxActions: number; listTarget: WebAgentListTarget | null; autoApprove: boolean },
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

/** Browser-mutable: enable/disable an already-registered server. Registering a new one stays CLI-only. */
export async function setMcpServerEnabled(
  port: number,
  token: string,
  id: string,
  enabled: boolean,
): Promise<McpServersResponse> {
  const body = await call(port, '/v1/mcp/servers/enable', { method: 'POST', token, body: JSON.stringify({ id, enabled }) });
  if (!isMcpServersResponse(body)) throw new HttpError(0, 'protocol', 'unexpected mcp servers response');
  return body;
}

export async function removeMcpServer(port: number, token: string, id: string): Promise<McpServersResponse> {
  const body = await call(port, '/v1/mcp/servers/remove', { method: 'POST', token, body: JSON.stringify({ id }) });
  if (!isMcpServersResponse(body)) throw new HttpError(0, 'protocol', 'unexpected mcp servers response');
  return body;
}

// ── Brain tab chat (Manual mode) ────────────────────────────────────────────

/** The one call site with a longer-than-usual timeout — a chat reply genuinely needs to wait out claude -p. */
export async function askChat(port: number, token: string, message: string, history: ChatTurn[]): Promise<ChatResponse> {
  const body = await call(port, '/v1/chat', {
    method: 'POST',
    token,
    timeoutMs: CHAT_TIMEOUT_MS,
    body: JSON.stringify({ message, history }),
  });
  if (!isChatResponse(body)) throw new HttpError(0, 'protocol', 'unexpected chat response');
  return body;
}

// ── web agent (paired mode) ─────────────────────────────────────────────────

/**
 * One brain step of the paired web agent: send the assembled prompt (steering +
 * goal + action history + latest page snapshot), get back the raw claude -p text
 * for the SW to parse into one JSON action. Same long timeout as chat — it waits
 * out a full claude -p round trip.
 */
export async function postActStep(port: number, token: string, prompt: string): Promise<string> {
  const body = (await call(port, '/v1/act/step', {
    method: 'POST',
    token,
    timeoutMs: CHAT_TIMEOUT_MS,
    body: JSON.stringify({ prompt }),
  })) as { text?: unknown };
  return typeof body.text === 'string' ? body.text : '';
}

/**
 * One brain step through the server's PERSISTENT per-run claude session — the
 * fast path: the server keeps one warm `claude` process per runId, so only
 * `message` (this turn's delta) is new tokens. `bootstrap` (the full legacy
 * prompt) rides along on every call purely as respawn fuel: if the server's
 * process died or expired, it replays the compact history transparently.
 * A 404 means an older server without the route — the caller falls back to
 * postActStep for the rest of the run.
 */
export async function postActSessionStep(
  port: number,
  token: string,
  runId: string,
  bootstrap: string,
  message: string,
): Promise<string> {
  const body = (await call(port, '/v1/act/session/step', {
    method: 'POST',
    token,
    timeoutMs: CHAT_TIMEOUT_MS,
    body: JSON.stringify({ runId, bootstrap, message }),
  })) as { text?: unknown };
  return typeof body.text === 'string' ? body.text : '';
}

/** Fire-and-forget session cleanup at run end — the server's idle timer is the
 *  backstop when the SW dies before this is sent. */
export async function postActSessionEnd(port: number, token: string, runId: string): Promise<void> {
  try {
    await call(port, '/v1/act/session/end', { method: 'POST', token, body: JSON.stringify({ runId }) });
  } catch {
    /* cleanup only — never let it fail a finished run */
  }
}

// ── Record & automate (paired mode) ─────────────────────────────────────────

export async function getWorkflows(port: number, token: string): Promise<WorkflowsResponse> {
  const body = await call(port, '/v1/workflows', { token });
  if (!isWorkflowsResponse(body)) throw new HttpError(0, 'protocol', 'unexpected workflows response');
  return body;
}

/** ONE workflow's full replayable spec — the web agent's replay path needs
 *  the steps, unlike getWorkflows()' summary list. */
export async function getWorkflow(port: number, token: string, id: string): Promise<WorkflowSpecResponse> {
  const body = await call(port, `/v1/workflow?id=${encodeURIComponent(id)}`, { token });
  if (!isWorkflowSpecResponse(body)) throw new HttpError(0, 'protocol', 'unexpected workflow response');
  return body;
}

/** Distill a finished recording into a workflow node server-side. Same long
 *  timeout as chat/act — it waits out a full claude -p round trip. */
export async function postTrace(port: number, token: string, trace: TraceRecord): Promise<TraceDistillResponse> {
  const body = await call(port, '/v1/trace', {
    method: 'POST',
    token,
    timeoutMs: CHAT_TIMEOUT_MS,
    body: JSON.stringify(trace),
  });
  if (!isTraceDistillResponse(body)) throw new HttpError(0, 'protocol', 'unexpected trace response');
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
