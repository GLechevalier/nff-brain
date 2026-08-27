// Two protocols in one file, both value-free apart from the type guards, in the
// same discipline as packages/vscode/src/protocol.ts:
//   1. popup ⇄ service worker (chrome.runtime messages)
//   2. extension → nff-brain serve (the /v1 HTTP surface)

import type {
  ActRunState,
  AllowRule,
  BrainMode,
  BrainModePref,
  Capture,
  CodeProjectMeta,
  ConnectionPhase,
  Health,
  ModelSlots,
  ProviderTestResult,
} from './schema.js';
import type { ProviderId } from '@nff-brain/core/provider';
import type { WorkflowSpec } from '@nff-brain/core/workflow';
import type { BrainEdge, BrainNode } from '@nff-brain/core/types';

/**
 * Owned by item 0 (packages/core/src/serveConfig.ts). This is the ONLY place
 * the number is written on the extension side — the popup exposes it as an
 * editable field so a port collision is a one-field fix, not a re-release.
 */
export const DEFAULT_PORT = 7373;
export const PORT_PROBE_COUNT = 5;

/** CRM sync host (optional_host_permissions + CSP connect-src). Lives here —
 *  not in crmSync.ts — so the side panel can request the grant without
 *  bundling the SW-side sync module. */
export const CRM_ORIGIN_PATTERN = 'https://admin.nanoforgeflow.com/*';

/** Always the literal loopback IP: `localhost` is dual-stack and can resolve to
 *  ::1, which the server deliberately does not bind. */
export const HOST = '127.0.0.1';

export const REQUEST_TIMEOUT_MS = 2500;

// ── the wire (extension → server) ────────────────────────────────────────────

export interface HelloResponse {
  ok: true;
  name: 'nff-brain';
  protocol: number;
  version: string;
  serverId: string;
  paired: boolean;
  pairing: boolean;
  proof?: string;
}

export interface PairResponse {
  ok: true;
  token: string;
  clientId: string;
  serverId: string;
  origin: string;
}

export interface BrainSide {
  brainPath: string;
  exists: boolean;
  nodes: number;
  edges: number;
  updatedAt?: string;
  error?: string;
}

export interface StatusResponse {
  ok: true;
  protocol: number;
  version: string;
  serverId: string;
  workspace: BrainSide & { root: string; name: string };
  global: BrainSide;
  merged: { nodes: number; edges: number };
  capture: { defaultTarget: 'global' | 'project' };
  queue: { path: string; pending: number; bytes: number; full: boolean; maxBytes: number };
}

export interface ClipResponse {
  ok: true;
  id: string;
  target: 'global' | 'project';
  pending: number;
}

export interface ClipsMapEntry {
  clipId: string;
  nodeIds: string[];
  at: string;
}

export interface ClipsMapResponse {
  ok: true;
  map: ClipsMapEntry[];
}

export interface RetractResponse {
  ok: true;
  /** Node ids the server actually deleted — reconcile against this, not the request. */
  removed: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isBrainSide(v: unknown): boolean {
  return isObj(v) && typeof v.nodes === 'number' && typeof v.edges === 'number';
}

export function isHelloResponse(v: unknown): v is HelloResponse {
  return isObj(v) && v.ok === true && v.name === 'nff-brain' && typeof v.protocol === 'number';
}

export function isPairResponse(v: unknown): v is PairResponse {
  return isObj(v) && v.ok === true && typeof v.token === 'string' && typeof v.clientId === 'string';
}

/**
 * NEVER TRUST THE WIRE. A malformed body is a DISCONNECT, not a connection
 * reporting zero nodes — "0 nodes" is a real and alarming state, and it must
 * not be manufacturable by a broken or truncated response.
 */
export function isStatusResponse(v: unknown): v is StatusResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    typeof v.version === 'string' &&
    isBrainSide(v.workspace) &&
    isBrainSide(v.global) &&
    isObj(v.merged) &&
    typeof v.merged.nodes === 'number'
  );
}

// ── DevTools Brain panel (item 3 + 5) ────────────────────────────────────────

/** Poll cadence while the panel is visible; devtools pages live while open. */
export const PANEL_POLL_MS = 5000;
export const SEARCH_DEBOUNCE_MS = 300;

export interface NodeSummary {
  id: string;
  title: string;
  category: string;
  origin: string;
  source: 'project' | 'global';
  lastUpdated: string;
  excerpt: string;
}

export interface NodesResponse {
  ok: true;
  updatedAt: string | null;
  merged: { nodes: number; edges: number };
  workspace: { name: string; nodes: number; edges: number };
  global: { nodes: number; edges: number };
  recent: NodeSummary[];
}

export interface SearchHit extends NodeSummary {
  score: number;
  related: Array<{ id: string; title: string; strength: number }>;
}

export interface SearchResponse {
  ok: true;
  q: string;
  count: number;
  hits: SearchHit[];
}

export function isNodesResponse(v: unknown): v is NodesResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    isObj(v.merged) &&
    typeof v.merged.nodes === 'number' &&
    Array.isArray(v.recent) &&
    v.recent.every((n) => isObj(n) && typeof n.id === 'string' && typeof n.title === 'string')
  );
}

export function isSearchResponse(v: unknown): v is SearchResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    typeof v.q === 'string' &&
    Array.isArray(v.hits) &&
    v.hits.every((h) => isObj(h) && typeof h.id === 'string' && typeof h.title === 'string')
  );
}

// ── Graph tab canvas — the full node/edge set with geometry ──────────────────

export interface GraphNode {
  id: string;
  title: string;
  category: string;
  origin: string;
  x: number;
  y: number;
  size: number;
  color: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  strength: number;
}

export interface GraphResponse {
  ok: true;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function isGraphResponse(v: unknown): v is GraphResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.nodes) &&
    v.nodes.every((n) => isObj(n) && typeof n.id === 'string' && typeof n.x === 'number' && typeof n.y === 'number') &&
    Array.isArray(v.edges) &&
    v.edges.every((e) => isObj(e) && typeof e.from === 'string' && typeof e.to === 'string')
  );
}

/**
 * GET /v1/export — the paired server's merged brain, full content (unlike
 * `nodes`/`search` excerpts), for seeding the local BYOK retrieval store.
 */
export interface ExportResponse {
  ok: true;
  updatedAt: string | null;
  nodes: BrainNode[];
  edges: BrainEdge[];
}

export function isExportResponse(v: unknown): v is ExportResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.nodes) &&
    v.nodes.every((n) => isObj(n) && typeof n.id === 'string' && typeof n.title === 'string') &&
    Array.isArray(v.edges) &&
    v.edges.every((e) => isObj(e) && typeof e.from === 'string' && typeof e.to === 'string')
  );
}

/** A node the reader dragged and dropped in the Graph tab, sent to persist. */
export interface LayoutResponse {
  ok: true;
  /** false only when the id no longer exists (deleted between render and drop). */
  moved: boolean;
}

export function isLayoutResponse(v: unknown): v is LayoutResponse {
  return isObj(v) && v.ok === true && typeof v.moved === 'boolean';
}

export function isClipsMapResponse(v: unknown): v is ClipsMapResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.map) &&
    v.map.every(
      (e) =>
        isObj(e) &&
        typeof e.clipId === 'string' &&
        Array.isArray(e.nodeIds) &&
        e.nodeIds.every((id: unknown) => typeof id === 'string'),
    )
  );
}

export function isRetractResponse(v: unknown): v is RetractResponse {
  return isObj(v) && v.ok === true && Array.isArray(v.removed) && v.removed.every((id: unknown) => typeof id === 'string');
}

// ── POST /v1/import — standalone→paired brain migration ──────────────────────

export interface ImportResponse {
  ok: true;
  imported: number;
  /** Ids the server re-minted on collision — MUST be applied to activity nodeIds. */
  remapped: Array<{ from: string; to: string }>;
  evicted: string[];
}

export function isImportResponse(v: unknown): v is ImportResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    typeof v.imported === 'number' &&
    Array.isArray(v.remapped) &&
    v.remapped.every((r: unknown) => isObj(r) && typeof r.from === 'string' && typeof r.to === 'string') &&
    Array.isArray(v.evicted)
  );
}

// ── web agent (item 7) — extension → nff-brain serve ────────────────────────
//
// Independently redeclared rather than imported from @nff-brain/core, same
// discipline as everything above this line: bundlePurity.test.ts only allows
// this package to import the browser-safe core subpaths (score/vector/rank/
// activity), so every server response shape this bundle needs to trust gets
// its own local type + type guard here.

export type WebAgentVerb = 'navigate' | 'readResultCards' | 'clickConnect';
export type RunPhase = 'planning' | 'awaiting_approval' | 'running' | 'stopping' | 'stopped' | 'done' | 'error';
export type PlanVerb = 'searchPeople' | 'evaluateCards';

export interface AgentCardResult {
  cardIndex: number;
  name: string;
  headline: string;
  company?: string;
}

export interface PlanStep {
  id: string;
  summary: string;
  verb: PlanVerb;
  args: Record<string, string>;
}

export interface WebAgentPlan {
  goal: string;
  site: 'linkedin';
  criteria: string;
  steps: PlanStep[];
  maxActions: number;
  createdAt: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface WebAgentListTarget {
  server: string;
  tool: string;
  toolDef: McpToolDef;
}

export interface ActionResult {
  ok: boolean;
  summary: string;
  fields?: Record<string, string>;
  cards?: AgentCardResult[];
  reportedAt: string;
  listWriteError?: string;
}

export interface ActionRecord {
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
  requestedAt: string;
  result?: ActionResult;
}

export interface WebAgentRun {
  id: string;
  phase: RunPhase;
  clientId: string;
  goal: string;
  /** Auto mode: the plan was (or will be) approved automatically, no review click. */
  autoApprove: boolean;
  plan: WebAgentPlan | null;
  listTarget: WebAgentListTarget | null;
  cursor: number;
  pendingConnects: AgentCardResult[];
  pendingConnectsStepId: string | null;
  actionsTaken: number;
  maxActions: number;
  nextAllowedAtMs: number;
  createdAt: string;
  updatedAt: string;
  history: ActionRecord[];
  error?: string;
}

export interface NextAction {
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
}

export interface AgentGoalResponse {
  ok: true;
  runId: string;
}

export interface AgentStatusResponse {
  ok: true;
  run: WebAgentRun | null;
  /**
   * The requesting client's most recent ARCHIVED run. Terminal phases are
   * archived out of `run` in the same server-side write that lands them, so
   * this is the only place a finished run's phase/error is still observable.
   * Optional: an older server simply doesn't send it.
   */
  lastRun?: WebAgentRun | null;
}

export interface AgentNextActionResponse {
  ok: true;
  action: NextAction | null;
  nextAllowedAtMs?: number;
}

function isRunPhase(v: unknown): v is RunPhase {
  return (
    typeof v === 'string' &&
    ['planning', 'awaiting_approval', 'running', 'stopping', 'stopped', 'done', 'error'].includes(v)
  );
}

/** NEVER TRUST THE WIRE. A malformed run reads as null — the page shows "no active run", never a crash. */
function isWebAgentRun(v: unknown): v is WebAgentRun {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    isRunPhase(v.phase) &&
    typeof v.goal === 'string' &&
    typeof v.cursor === 'number' &&
    typeof v.actionsTaken === 'number' &&
    typeof v.maxActions === 'number' &&
    Array.isArray(v.history)
  );
}

export function isAgentGoalResponse(v: unknown): v is AgentGoalResponse {
  return isObj(v) && v.ok === true && typeof v.runId === 'string';
}

export function isAgentStatusResponse(v: unknown): v is AgentStatusResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    (v.run === null || isWebAgentRun(v.run)) &&
    (v.lastRun === undefined || v.lastRun === null || isWebAgentRun(v.lastRun))
  );
}

export function isAgentNextActionResponse(v: unknown): v is AgentNextActionResponse {
  return isObj(v) && v.ok === true && (v.action === null || (isObj(v.action) && typeof v.action.stepId === 'string'));
}

// ── MCP servers (item 7) — extension → nff-brain serve ───────────────────────

export interface McpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
}

export interface McpServersResponse {
  ok: true;
  servers: McpServerSummary[];
}

export interface McpToolsResponse {
  ok: true;
  tools: McpToolDef[];
}

export function isMcpServersResponse(v: unknown): v is McpServersResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.servers) &&
    v.servers.every((s: unknown) => isObj(s) && typeof s.id === 'string' && typeof s.name === 'string')
  );
}

export function isMcpToolsResponse(v: unknown): v is McpToolsResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.tools) &&
    v.tools.every((t: unknown) => isObj(t) && typeof t.name === 'string')
  );
}

// ── Brain tab chat (Manual mode) — extension → nff-brain serve ───────────────
//
// Unlike every other route, a chat exchange genuinely needs to wait out a
// full claude -p round trip — CHAT_TIMEOUT_MS is what client.ts's askChat()
// passes as call()'s timeoutMs override instead of the blanket
// REQUEST_TIMEOUT_MS every other call site uses. A real synthesized answer
// (multiple retrieved notes, several paragraphs) measured 30-34s end to end,
// so 45s cut it too close. Kept a few seconds ABOVE the server's own
// CHAT_TIMEOUT_MS (packages/cli/src/serve/chatRoutes.ts) on purpose: if the
// brain does time out, the server's more specific error should win the race
// and reach the panel instead of this client aborting first and masking it
// behind the generic "did not answer in time" message below.

export const CHAT_TIMEOUT_MS = 95_000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatSource {
  id: string;
  title: string;
}

export interface ChatResponse {
  ok: true;
  answer: string;
  sources: ChatSource[];
}

export function isChatResponse(v: unknown): v is ChatResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    typeof v.answer === 'string' &&
    Array.isArray(v.sources) &&
    v.sources.every((s: unknown) => isObj(s) && typeof s.id === 'string' && typeof s.title === 'string')
  );
}

// ── GET /v1/workflows + POST /v1/trace — paired Record & automate ────────────

export interface WorkflowSummary {
  id: string;
  title: string;
  intent: string;
  site: string;
  params: string[];
}

export interface WorkflowsResponse {
  ok: true;
  items: WorkflowSummary[];
}

export function isWorkflowsResponse(v: unknown): v is WorkflowsResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    Array.isArray(v.items) &&
    v.items.every(
      (i: unknown) =>
        isObj(i) &&
        typeof i.id === 'string' &&
        typeof i.title === 'string' &&
        typeof i.intent === 'string' &&
        typeof i.site === 'string' &&
        Array.isArray(i.params) &&
        i.params.every((p: unknown) => typeof p === 'string'),
    )
  );
}

export interface WorkflowSpecResponse {
  ok: true;
  id: string;
  title: string;
  spec: WorkflowSpec;
}

export function isWorkflowSpecResponse(v: unknown): v is WorkflowSpecResponse {
  return isObj(v) && v.ok === true && typeof v.id === 'string' && typeof v.title === 'string' && isObj(v.spec);
}

export interface TraceDistillResponse {
  ok: true;
  nodeId: string;
  evicted: string[];
}

export function isTraceDistillResponse(v: unknown): v is TraceDistillResponse {
  return isObj(v) && v.ok === true && typeof v.nodeId === 'string' && Array.isArray(v.evicted);
}

// ── SW ↔ content script (LinkedIn agent adapter) ─────────────────────────────
//
// A THIRD, narrower channel than the two above: only two verbs ever cross it,
// and unlike popup⇄SW it flows SW→content (a command) and content→SW (via
// sendResponse inside the SAME onMessage call, never a separate sendMessage —
// bundlePurity.test.ts pins that content scripts only ever call sendMessage
// with type:'recorderEvent', so this reply path deliberately never does).

export type SwToContent = { type: 'agentReadCards' } | { type: 'agentClickConnect'; cardIndex: number };

export type ContentToAgentReply =
  | { ok: true; verb: 'readResultCards'; cards: AgentCardResult[] }
  | { ok: true; verb: 'clickConnect'; fields: { name: string; headline?: string; company?: string } }
  | { ok: false; error: string };

// ── popup ⇄ service worker ───────────────────────────────────────────────────

export type PopupToSw =
  | { type: 'getState' }
  | { type: 'probeNow' }
  | { type: 'pair'; port: number; code: string }
  | { type: 'unpair' }
  | { type: 'setCaptureEnabled'; enabled: boolean }
  | { type: 'addRule'; input: string }
  | { type: 'removeRule'; host: string }
  | { type: 'clearActivity'; alsoRemoveNodes: boolean }
  // DevTools panel — routed through the worker so the token never enters the
  // panel realm (same discipline as PublicState omitting it).
  | { type: 'getNodes'; limit?: number }
  | { type: 'searchBrain'; q: string; limit?: number }
  | { type: 'getGraph' }
  // A node the reader dragged and dropped on the Graph tab canvas.
  | { type: 'moveGraphNode'; id: string; x: number; y: number }
  // Recorders. The popup runs chrome.permissions.request itself (a user
  // gesture is required there); this message only flips state + registration.
  | { type: 'setRecorderEnabled'; id: string; enabled: boolean }
  // Web agent (item 7) — lives in the DevTools panel (PanelToSw below), so the
  // token stays SW-side exactly like getNodes/searchBrain above. Enabling the
  // LinkedIn adapter runs chrome.permissions.request in the CALLING page
  // (popup or panel — a user gesture is required there); this message only
  // flips state + registration, same split as recorders.
  | { type: 'setAgentAdapterEnabled'; id: string; enabled: boolean }
  // Manual-mode chat's action-intent permission prompt (item 7 sibling, NOT
  // the goal/plan pipeline below): "never ask again" for one adapter, and
  // actually opening a tab to it once permission is granted (once or always).
  | { type: 'setAgentActionAllowed'; adapterId: string; allowed: boolean }
  // tabId is the DevTools-inspected tab (panel.ts's chrome.devtools.inspectedWindow.tabId)
  // so "Yes"/"Never ask again" navigates that tab in place — a new tab would leave the
  // F12 panel attached to the wrong (now-irrelevant) page.
  | { type: 'runAdapterNavigate'; adapterId: string; tabId: number }
  // The same prompt, generalized to a site with no registered adapter —
  // actionIntent.ts's 'kind: host' match. Host-keyed "never ask again", and
  // a direct same-tab navigate with no adapter lookup involved.
  | { type: 'setNavigateHostAllowed'; host: string; allowed: boolean }
  | { type: 'runNavigateHost'; url: string; tabId: number }
  // Manual-mode chat's history-navigation shortcut (actionIntent.ts's 'kind:
  // history' match) — "go back"/"navigate forward". No permission target:
  // acting on the tab's own history is auto-granted, same as the CDP web
  // agent's nav.back/nav.forward VERB_CLASS.
  | { type: 'runNavigateHistory'; direction: 'back' | 'forward'; tabId: number }
  | { type: 'agentSubmitGoal'; goal: string; maxActions: number; listTarget: WebAgentListTarget | null; autoApprove: boolean }
  | { type: 'agentApprovePlan'; runId: string }
  | { type: 'agentRejectPlan'; runId: string }
  | { type: 'agentStop'; runId: string }
  | { type: 'getAgentStatus' }
  // Manual-mode chat — the one route that costs a token per message,
  // deliberately opt-in (Manual is a mode the user picks, not the default
  // reply path for every prompt).
  // tabId: same DevTools-inspected-tab reasoning as runAdapterNavigate above —
  // the navigate tool (standalone.ts) needs it to stay on the same tab too.
  | { type: 'chatAsk'; message: string; history: ChatTurn[]; tabId: number }
  // MCP tab: read-only listing already existed (getMcpServers/getMcpTools);
  // these two are the new browser-mutable surface — enable/disable/remove an
  // ALREADY-registered server. Registering a NEW one stays CLI-only.
  | { type: 'getMcpServers' }
  | { type: 'getMcpTools'; server: string }
  | { type: 'setMcpServerEnabled'; id: string; enabled: boolean }
  | { type: 'removeMcpServer'; id: string }
  // BYOK provider settings (options page). setProvider is the ONE message that
  // carries the key inbound; nothing ever carries it back out.
  | { type: 'setProvider'; provider: ProviderId; apiKey: string }
  | { type: 'setProviderModels'; models: ModelSlots }
  | { type: 'clearProvider' }
  | { type: 'testProvider' }
  // CRM sync (Settings). setCrmSyncSecret is the ONE message that carries the
  // ingest secret inbound; nothing ever carries it back out.
  | { type: 'setCrmSyncSecret'; secret: string }
  | { type: 'setCrmSyncEnabled'; enabled: boolean }
  | { type: 'clearCrmSync' }
  // Explicit brain-mode preference (Settings segmented control) — which
  // backend drives LLM work when both are configured. See mode.ts.
  | { type: 'setBrainMode'; mode: BrainModePref }
  // One-way, on-demand seed of the local BYOK retrieval store from the paired
  // server's brain (GET /v1/export → capped merge). Never automatic.
  | { type: 'importBrainFromServer' }
  // Web-agent action engine (CDP). The panel requests the optional `debugger`
  // permission itself (a user gesture is required in the calling page); these
  // messages only start/steer/stop the run and answer its origin-grant prompt.
  | { type: 'actStart'; goal: string; tabId: number; maxActions?: number; workflowId?: string; mode?: 'manual' | 'plan' | 'auto'; codeEnabled?: boolean }
  | { type: 'getWorkflows' }
  | { type: 'actStop' }
  | { type: 'actEnd' }
  | { type: 'actGrant'; choice: 'once' | 'always' | 'never' }
  | { type: 'getActStatus' }
  // Coding agent: the panel picked a project folder (the handle is already in
  // IndexedDB — fsHandles.ts — because showDirectoryPicker must run in the
  // panel's window context; this message only records the JSON metadata), or
  // detached it, or wants the current status, or flipped the per-run
  // auto-approve toggle for writes/commands.
  | { type: 'codeAttached'; name: string }
  | { type: 'codeDetach' }
  | { type: 'getCodeStatus' }
  | { type: 'codeAutoApprove'; enabled: boolean }
  // Revoke a persisted per-origin action grant (from the popup).
  | { type: 'revokeActOrigin'; origin: string }
  // Record-and-automate. The popup starts/stops a per-tab recording; the finished
  // trace lands in the pending slot for distillation into a workflow.
  | { type: 'traceStart'; tabId: number }
  | { type: 'traceStop' }
  | { type: 'traceCancel' }
  | { type: 'getTraceStatus' };

/** The panel speaks the same channel as the popup — including the item-7 Agent tab. */
export type PanelToSw = PopupToSw;

/**
 * Everything the popup renders. Deliberately NOT StoredState: the bearer token
 * never crosses this channel. The popup has no use for it, and keeping it out
 * means a future popup bug cannot leak it into the DOM.
 */
export interface RecorderRow {
  id: string;
  label: string;
  hosts: string[];
  enabled: boolean;
  /** Whether the host permission is currently granted. */
  granted: boolean;
  /** Whether the adapter's hosts pass the allowlist right now. */
  allowlisted: boolean;
}

/** Same shape as RecorderRow — a distinct type because it is a distinct opt-in. */
export interface AgentAdapterRow {
  id: string;
  label: string;
  hosts: string[];
  enabled: boolean;
  granted: boolean;
}

export interface PublicState {
  phase: ConnectionPhase;
  port: number | null;
  health: Omit<Health, 'nextProbeAtMs'>;
  capture: Capture;
  rules: AllowRule[];
  activityCount: number;
  /** Σ nodeIds.length — drives whether the clear-history checkbox renders. */
  removableNodeCount: number;
  recorders: RecorderRow[];
  agentAdapters: AgentAdapterRow[];
  /** Adapter ids Manual-mode chat may act on without asking — "never ask again". */
  agentActionAllow: string[];
  /** Same "never ask again", but for generic navigate hosts with no registered adapter. */
  navigateHostAllow: string[];
  // BYOK provider (standalone mode). ZERO key material crosses this channel —
  // not even a last-4 hint; same total-omission posture as the bearer token.
  providerConfigured: boolean;
  provider: ProviderId | null;
  // CRM sync — booleans only, same total-omission posture as the secrets above.
  crmSyncConfigured: boolean;
  crmSyncEnabled: boolean;
  providerModels: ModelSlots | null;
  providerLastTest: ProviderTestResult | null;
  /** RESOLVED brain mode — which backend drives LLM work right now (mode.ts).
   *  Distinct from `phase`: the connection dot keeps reporting server health
   *  even while the BYOK backend is the one answering. */
  brainMode: BrainMode;
  /** The user's stored preference, null when never set (legacy rule applies). */
  brainModePref: BrainModePref | null;
  /** A pre-upgrade user's leftover local brain, awaiting the one-time
   *  migration sweep into the paired brain; null once none remains. */
  migrationPending: number | null;
}

export type SwToPopup =
  | { type: 'state'; state: PublicState }
  | { type: 'error'; message: string }
  | { type: 'nodes'; data: NodesResponse }
  | { type: 'search'; data: SearchResponse }
  | { type: 'graph'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'layout'; moved: boolean }
  | { type: 'agentStatus'; run: WebAgentRun | null; lastRun?: WebAgentRun | null }
  | { type: 'chatAnswer'; answer: string; sources: ChatSource[] }
  | { type: 'mcpServers'; servers: McpServerSummary[] }
  | { type: 'mcpTools'; tools: McpToolDef[] }
  | { type: 'providerTest'; result: ProviderTestResult }
  | { type: 'actStatus'; run: ActRunState | null }
  // permission mirrors fsHandles.ts's ProjectPermission — inlined so this
  // file keeps its zero-value-import discipline.
  | { type: 'codeStatus'; project: CodeProjectMeta | null; permission: 'granted' | 'prompt' | 'denied' | 'missing' }
  | { type: 'traceStatus'; recording: boolean; eventCount: number; pending: { id: string; events: number; startUrl: string; title?: string } | null }
  | { type: 'workflows'; items: WorkflowSummary[] }
  | { type: 'brainImported'; imported: number; total: number };

export type SwToPanel = SwToPopup;
