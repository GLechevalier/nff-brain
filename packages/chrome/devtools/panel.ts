// The Brain panel document: two tabs — Brain (a chat-style transcript with a
// Manual/Plan/Auto mode switch) and MCP (registered-connection management).
//
// A devtools panel lives as long as devtools is open, so unlike the service
// worker this document MAY hold module state (same as popup/main.ts). All HTTP
// goes through the service worker via messages — the pairing token never
// enters this realm, and this document makes zero network requests of its own.

import { agentAdapterById } from '../src/agentRegistry.js';
import { detectActionIntent, type ActionIntent } from '../src/actionIntent.js';
import { PANEL_POLL_MS } from '../src/protocol.js';
import type { ChatTurn, GraphEdge, GraphNode, McpServerSummary, McpToolDef, NodesResponse, PanelToSw, SwToPanel, WebAgentListTarget, WebAgentRun } from '../src/protocol.js';
import {
  paintAdapter,
  paintHeader,
  paintMcpServerOptions,
  paintMcpToolOptions,
  paintMode,
  renderGraph,
  renderMcpList,
  renderTranscript,
  setGraphViewBox,
  setNodePosition,
  showFieldError,
  switchTab,
  type ChatMode,
  type GraphHandlers,
  type GraphViewBox,
  type McpListItem,
  type PanelTab,
  type TranscriptEntry,
} from './panelPaint.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const AGENT_STATUS_POLL_MS = 4000;
const CHAT_HISTORY_TURNS_MAX = 6;

// Cycling "waiting for a reply" words, shown in the transcript between
// sending a prompt and the answer/plan/run entry landing — same spirit as
// Claude Code CLI's spinner words, themed for a knowledge-brain assistant.
const PENDING_WORDS = [
  'Pondering…',
  'Percolating…',
  'Rummaging…',
  'Skimming your notes…',
  'Cross-referencing…',
  'Connecting the dots…',
  'Digging through the brain…',
  'Untangling…',
  'Mulling it over…',
  'Fetching thoughts…',
];
const PENDING_TICK_MS = 2000;

let latestNodes: NodesResponse | null = null;
let mode: ChatMode = 'manual';
let transcript: TranscriptEntry[] = [];
let chatHistory: ChatTurn[] = [];
const mcpToolsByServer = new Map<string, McpToolDef[]>();
let mcpListItems: McpListItem[] = [];
let agentPollTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let submitting = false;
let currentTab: PanelTab = 'brain';
let graphViewBox: GraphViewBox | null = null;
let panning = false;
let panStartClientX = 0;
let panStartClientY = 0;
let panStartBox: GraphViewBox | null = null;
let nodeDrag: { id: string; startClientX: number; startClientY: number; x0: number; y0: number; moved: boolean } | null = null;

function send(msg: PanelToSw): Promise<SwToPanel> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToPanel) => {
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

async function refreshNodes(): Promise<void> {
  const reply = await send({ type: 'getNodes' });
  if (reply.type !== 'nodes') {
    paintHeader(latestNodes, false);
    return;
  }
  latestNodes = reply.data;
  paintHeader(latestNodes, true);
}

/**
 * Standalone mode: Plan/Auto and the MCP tab are intrinsically server-backed
 * (web-agent state and MCP registry live in nff-brain serve), so they hide
 * rather than error. Brain (Manual chat) and Graph run off the local brain.
 */
function paintStandaloneMode(standalone: boolean): void {
  $('tab-mcp').classList.toggle('hidden', standalone);
  $('mode-plan').classList.toggle('hidden', standalone);
  $('mode-auto').classList.toggle('hidden', standalone);
  $('adapter-toggle').classList.toggle('hidden', standalone);
  if (standalone && mode !== 'manual') setMode('manual');
  if (standalone && currentTab === 'mcp') {
    currentTab = 'brain';
    switchTab('brain');
  }
}

async function refreshAdapterState(): Promise<void> {
  const reply = await send({ type: 'getState' });
  if (reply.type === 'state') {
    paintAdapter(reply.state);
    paintStandaloneMode(reply.state.phase === 'standalone');
  }
}

/**
 * Enable runs HERE, not in the SW: chrome.permissions.request needs a user
 * gesture, and this click is that gesture — same split as the popup's
 * toggleRecorder. A denied prompt leaves the agent off.
 */
async function toggleAdapter(): Promise<void> {
  const adapter = agentAdapterById('linkedin');
  if (!adapter) return;

  const stateReply = await send({ type: 'getState' });
  const enabled =
    stateReply.type === 'state' && stateReply.state.agentAdapters.find((a) => a.id === 'linkedin')?.enabled === true;

  if (enabled) {
    await send({ type: 'setAgentAdapterEnabled', id: 'linkedin', enabled: false });
    await refreshAdapterState();
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: adapter.originPatterns });
  } catch {
    granted = false;
  }
  if (!granted) {
    showFieldError('adapter-error', `Chrome permission for ${adapter.hosts.join(', ')} was not granted — the agent stays off.`);
    return;
  }
  showFieldError('adapter-error', null);
  await send({ type: 'setAgentAdapterEnabled', id: 'linkedin', enabled: true });
  await refreshAdapterState();
}

// ── mode switch ──────────────────────────────────────────────────────────────

function setMode(next: ChatMode): void {
  mode = next;
  paintMode(mode);
}

// ── goal-options selects (Plan/Auto mode's "add matches to") ────────────────

async function loadGoalOptionServers(): Promise<void> {
  const reply = await send({ type: 'getMcpServers' });
  if (reply.type !== 'mcpServers') return;
  paintMcpServerOptions(reply.servers, '');
  paintMcpToolOptions([], null);
}

async function loadGoalOptionTools(serverId: string): Promise<void> {
  if (!serverId) {
    paintMcpToolOptions([], null);
    return;
  }
  if (!mcpToolsByServer.has(serverId)) {
    const reply = await send({ type: 'getMcpTools', server: serverId });
    if (reply.type !== 'mcpTools') return;
    mcpToolsByServer.set(serverId, reply.tools);
  }
  paintMcpToolOptions(mcpToolsByServer.get(serverId) ?? [], null);
}

function selectedListTarget(): WebAgentListTarget | null {
  const serverId = ($('list-server') as HTMLSelectElement).value;
  if (!serverId) return null;
  const toolName = ($('list-tool') as HTMLSelectElement).value;
  const toolDef = mcpToolsByServer.get(serverId)?.find((t) => t.name === toolName);
  if (!toolDef) return null;
  return { server: serverId, tool: toolName, toolDef };
}

// ── the transcript's run/plan entries ────────────────────────────────────────

function isTerminalAgentPhase(phase: WebAgentRun['phase']): boolean {
  return phase === 'stopped' || phase === 'done' || phase === 'error';
}

function scheduleAgentPoll(delayMs: number): void {
  if (agentPollTimer) clearTimeout(agentPollTimer);
  agentPollTimer = setTimeout(() => void pollAgentStatus(), delayMs);
}

const transcriptHandlers = {
  onApprovePlan: (runId: string) => void approvePlan(runId),
  onDiscardPlan: (runId: string) => void discardPlan(runId),
  onStopRun: (runId: string) => void stopRun(runId),
  onPermissionDecision: (requestId: string, decision: 'yes' | 'no' | 'always') => void resolvePermission(requestId, decision),
};

function paintTranscript(): void {
  renderTranscript(transcript, transcriptHandlers);
}

/**
 * A single cycling-word entry shown while a reply is in flight, covering both
 * Manual chat (submitChat) and the gap before Plan/Auto's first agent-status
 * poll (submitGoal) — see submitPrompt's try/finally, the one place both
 * flows funnel through on success AND error.
 */
function pushPending(): void {
  let i = Math.floor(Math.random() * PENDING_WORDS.length);
  transcript.push({ kind: 'pending', word: PENDING_WORDS[i] });
  paintTranscript();
  pendingTimer = setInterval(() => {
    const entry = transcript.find((e): e is Extract<TranscriptEntry, { kind: 'pending' }> => e.kind === 'pending');
    if (!entry) return;
    i = (i + 1) % PENDING_WORDS.length;
    entry.word = PENDING_WORDS[i];
    paintTranscript();
  }, PENDING_TICK_MS);
}

function clearPending(): void {
  if (pendingTimer) clearInterval(pendingTimer);
  pendingTimer = null;
  transcript = transcript.filter((e) => e.kind !== 'pending');
}

/** Finds the entry for this run (there is at most one — see applyRunUpdate) or null. */
function findRunEntry(runId: string): Extract<TranscriptEntry, { kind: 'plan' | 'run' }> | undefined {
  return transcript.find((e): e is Extract<TranscriptEntry, { kind: 'plan' | 'run' }> => (e.kind === 'plan' || e.kind === 'run') && e.runId === runId);
}

/** One entry per run, reclassified plan → run the moment it stops awaiting approval. */
function applyRunUpdate(run: WebAgentRun): void {
  const kind = run.phase === 'awaiting_approval' ? 'plan' : 'run';
  const existing = findRunEntry(run.id);
  if (existing) {
    existing.kind = kind;
    existing.run = run;
  } else {
    transcript.push({ kind, runId: run.id, run });
  }
  paintTranscript();
}

async function pollAgentStatus(): Promise<void> {
  const reply = await send({ type: 'getAgentStatus' });
  if (reply.type === 'agentStatus' && reply.run) {
    applyRunUpdate(reply.run);
    if (!isTerminalAgentPhase(reply.run.phase)) scheduleAgentPoll(AGENT_STATUS_POLL_MS);
  }
}

async function approvePlan(runId: string): Promise<void> {
  const reply = await send({ type: 'agentApprovePlan', runId });
  if (reply.type === 'agentStatus' && reply.run) applyRunUpdate(reply.run);
  scheduleAgentPoll(1000);
}

async function discardPlan(runId: string): Promise<void> {
  const reply = await send({ type: 'agentRejectPlan', runId });
  if (reply.type === 'agentStatus' && reply.run) applyRunUpdate(reply.run);
}

async function stopRun(runId: string): Promise<void> {
  const reply = await send({ type: 'agentStop', runId });
  if (reply.type === 'agentStatus' && reply.run) applyRunUpdate(reply.run);
}

// ── Manual-mode chat's action-intent permission prompt ──────────────────────

function findPermissionEntry(requestId: string): Extract<TranscriptEntry, { kind: 'permission' }> | undefined {
  return transcript.find((e): e is Extract<TranscriptEntry, { kind: 'permission' }> => e.kind === 'permission' && e.requestId === requestId);
}

async function resolvePermission(requestId: string, decision: 'yes' | 'no' | 'always'): Promise<void> {
  const entry = findPermissionEntry(requestId);
  if (!entry) return;
  entry.decision = decision;
  paintTranscript();

  if (decision === 'no') return;
  if (decision === 'always') await send({ type: 'setAgentActionAllowed', adapterId: entry.adapterId, allowed: true });
  await send({ type: 'runAdapterNavigate', adapterId: entry.adapterId, tabId: chrome.devtools.inspectedWindow.tabId });
}

// ── submitting the prompt — branches on mode ─────────────────────────────────

function pushChatTurn(turn: ChatTurn): void {
  chatHistory.push(turn);
  chatHistory = chatHistory.slice(-CHAT_HISTORY_TURNS_MAX);
}

async function submitChat(message: string): Promise<void> {
  const reply = await send({ type: 'chatAsk', message, history: chatHistory, tabId: chrome.devtools.inspectedWindow.tabId });
  if (reply.type === 'error') {
    showFieldError('prompt-error', reply.message);
    return;
  }
  if (reply.type !== 'chatAnswer') return;
  transcript.push({ kind: 'answer', text: reply.answer, sources: reply.sources });
  pushChatTurn({ role: 'user', text: message });
  pushChatTurn({ role: 'assistant', text: reply.answer });
  paintTranscript();
}

/**
 * The action-intent shortcut — checked BEFORE mode branching, in EVERY mode,
 * so "navigate to linkedin" never gets misread as a recruiting goal by
 * Plan/Auto's planner (which only understands searchPeople/evaluateCards).
 * A match skips chatAsk/agentSubmitGoal entirely (no reason to pay for an
 * LLM call to a request we're about to act on directly instead). Standing
 * "never ask again" state is fetched fresh here, never cached, same
 * discipline as refreshAdapterState.
 *
 * Auto mode's whole point is "no review step" — that applies here exactly
 * like it does to a generated plan, so an intent match in Auto mode opens
 * the tab immediately, same as an already-always-allowed adapter. Manual and
 * Plan both still ask: Plan's entire premise is "show me before it runs".
 */
async function submitActionIntent(intent: ActionIntent): Promise<void> {
  const stateReply = await send({ type: 'getState' });
  const alwaysAllowed = stateReply.type === 'state' && stateReply.state.agentActionAllow.includes(intent.adapterId);

  if (alwaysAllowed || mode === 'auto') {
    await send({ type: 'runAdapterNavigate', adapterId: intent.adapterId, tabId: chrome.devtools.inspectedWindow.tabId });
    transcript.push({
      kind: 'permission',
      requestId: crypto.randomUUID(),
      adapterId: intent.adapterId,
      label: intent.label,
      url: intent.url,
      decision: alwaysAllowed ? 'always' : 'yes',
    });
    paintTranscript();
    return;
  }

  transcript.push({ kind: 'permission', requestId: crypto.randomUUID(), adapterId: intent.adapterId, label: intent.label, url: intent.url });
  paintTranscript();
}

async function submitGoal(message: string): Promise<void> {
  const maxActions = Number(($('max-actions') as HTMLInputElement).value) || 5;
  const listTarget = selectedListTarget();
  const reply = await send({
    type: 'agentSubmitGoal',
    goal: message,
    maxActions,
    listTarget,
    autoApprove: mode === 'auto',
  });
  if (reply.type === 'error') {
    showFieldError('prompt-error', reply.message);
    return;
  }
  const status = await send({ type: 'getAgentStatus' });
  if (status.type === 'agentStatus' && status.run) applyRunUpdate(status.run);
  scheduleAgentPoll(1000);
}

async function submitPrompt(): Promise<void> {
  if (submitting) return;
  const input = $('prompt-input') as HTMLTextAreaElement;
  const message = input.value.trim();
  if (!message) {
    showFieldError('prompt-error', 'type something first');
    return;
  }
  showFieldError('prompt-error', null);
  submitting = true;
  ($('prompt-send') as HTMLButtonElement).disabled = true;

  transcript.push({ kind: 'user', text: message });
  input.value = '';
  paintTranscript();
  pushPending();

  try {
    const intent = detectActionIntent(message);
    if (intent) await submitActionIntent(intent);
    else if (mode === 'manual') await submitChat(message);
    else await submitGoal(message);
  } finally {
    clearPending();
    paintTranscript();
    submitting = false;
    ($('prompt-send') as HTMLButtonElement).disabled = false;
  }
}

// ── MCP tab ───────────────────────────────────────────────────────────────────

function mergeMcpServers(servers: readonly McpServerSummary[]): void {
  const previousToolCount = new Map(mcpListItems.map((s) => [s.id, s.toolCount]));
  mcpListItems = servers.map((s) => ({ ...s, toolCount: previousToolCount.get(s.id) ?? null }));
}

const mcpListHandlers = {
  onTest: (id: string) => void testMcpServer(id),
  onToggleEnabled: (id: string, enabled: boolean) => void toggleMcpServer(id, enabled),
  onRemove: (id: string) => void removeMcpServerRow(id),
};

function paintMcpTab(): void {
  renderMcpList(mcpListItems, mcpListHandlers);
}

async function loadMcpTab(): Promise<void> {
  const reply = await send({ type: 'getMcpServers' });
  if (reply.type !== 'mcpServers') return;
  mergeMcpServers(reply.servers);
  paintMcpTab();
}

async function testMcpServer(id: string): Promise<void> {
  const reply = await send({ type: 'getMcpTools', server: id });
  if (reply.type !== 'mcpTools') {
    showFieldError('mcp-error', reply.type === 'error' ? reply.message : 'test failed');
    return;
  }
  showFieldError('mcp-error', null);
  const item = mcpListItems.find((s) => s.id === id);
  if (item) item.toolCount = reply.tools.length;
  paintMcpTab();
}

async function toggleMcpServer(id: string, enabled: boolean): Promise<void> {
  const reply = await send({ type: 'setMcpServerEnabled', id, enabled });
  if (reply.type !== 'mcpServers') return;
  mergeMcpServers(reply.servers);
  paintMcpTab();
}

async function removeMcpServerRow(id: string): Promise<void> {
  const reply = await send({ type: 'removeMcpServer', id });
  if (reply.type !== 'mcpServers') return;
  mergeMcpServers(reply.servers);
  paintMcpTab();
}

// ── Graph tab — renders geometry the CLI already computed; pan/zoom only ever
//    touch the viewBox, never rebuild the SVG (see setGraphViewBox). ─────────

let latestGraphNodes: GraphNode[] = [];
let latestGraphEdges: GraphEdge[] = [];

/**
 * resetView is true only on tab entry — a poll refresh must rebuild the
 * node/edge SVG (data may have changed) without discarding the user's
 * current pan/zoom, so it re-applies the preserved viewBox after rendering.
 */
async function loadGraph(resetView: boolean): Promise<void> {
  const reply = await send({ type: 'getGraph' });
  if (reply.type !== 'graph') {
    // Silent failure here reads as "zero nodes" — this is a reachability
    // error (SW down, brain not paired, stale server missing the route), and
    // it must say so rather than leave the canvas blank with no explanation.
    showFieldError('graph-error', reply.type === 'error' ? reply.message : 'graph unavailable');
    return;
  }
  showFieldError('graph-error', null);
  latestGraphNodes = reply.nodes;
  latestGraphEdges = reply.edges;
  const fitted = renderGraph(latestGraphNodes, latestGraphEdges, graphHandlers);
  if (resetView || !graphViewBox) {
    graphViewBox = fitted;
  } else {
    setGraphViewBox(graphViewBox);
  }
}

function zoomGraph(canvas: HTMLElement, clientX: number, clientY: number, factor: number): void {
  if (!graphViewBox) return;
  const rect = canvas.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  const box = graphViewBox;
  const w = box.w * factor;
  const h = box.h * factor;
  graphViewBox = { x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h };
  setGraphViewBox(graphViewBox);
}

function panGraph(canvas: HTMLElement, dxClient: number, dyClient: number): void {
  if (!panStartBox) return;
  const rect = canvas.getBoundingClientRect();
  const dx = (dxClient / rect.width) * panStartBox.w;
  const dy = (dyClient / rect.height) * panStartBox.h;
  graphViewBox = { ...panStartBox, x: panStartBox.x - dx, y: panStartBox.y - dy };
  setGraphViewBox(graphViewBox);
}

// Only past this many client px does a press count as a drag rather than a
// click — nodes have no click behaviour today, but a trivial jiggle still
// must not fire a network write.
const NODE_DRAG_THRESHOLD_PX = 3;

function dragNode(canvas: HTMLElement, clientX: number, clientY: number): { x: number; y: number } | null {
  if (!nodeDrag || !graphViewBox) return null;
  const rect = canvas.getBoundingClientRect();
  const dxClient = clientX - nodeDrag.startClientX;
  const dyClient = clientY - nodeDrag.startClientY;
  if (Math.abs(dxClient) + Math.abs(dyClient) > NODE_DRAG_THRESHOLD_PX) nodeDrag.moved = true;
  // SVG-space delta follows the mouse directly — the opposite sign from
  // panGraph, which moves the VIEW rather than the content.
  const x = nodeDrag.x0 + (dxClient / rect.width) * graphViewBox.w;
  const y = nodeDrag.y0 + (dyClient / rect.height) * graphViewBox.h;
  setNodePosition(nodeDrag.id, x, y);
  return { x, y };
}

const graphHandlers: GraphHandlers = {
  onNodeMouseDown: (id, e) => {
    const node = latestGraphNodes.find((n) => n.id === id);
    if (!node) return;
    nodeDrag = { id, startClientX: e.clientX, startClientY: e.clientY, x0: node.x, y0: node.y, moved: false };
    $('graph-canvas').classList.add('dragging-node');
  },
};

function wireGraphCanvas(): void {
  const canvas = $('graph-canvas');

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    zoomGraph(canvas, e.clientX, e.clientY, factor);
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (!graphViewBox) return;
    panning = true;
    panStartClientX = e.clientX;
    panStartClientY = e.clientY;
    panStartBox = graphViewBox;
    canvas.classList.add('panning');
  });

  window.addEventListener('mousemove', (e) => {
    if (nodeDrag) {
      dragNode(canvas, e.clientX, e.clientY);
      return;
    }
    if (!panning) return;
    panGraph(canvas, e.clientX - panStartClientX, e.clientY - panStartClientY);
  });

  window.addEventListener('mouseup', (e) => {
    if (nodeDrag) {
      const drag = nodeDrag;
      const pos = dragNode(canvas, e.clientX, e.clientY);
      nodeDrag = null;
      canvas.classList.remove('dragging-node');
      if (drag.moved && pos) {
        const node = latestGraphNodes.find((n) => n.id === drag.id);
        if (node) {
          // Update the local copy now so the next poll's rebuild doesn't
          // visually snap the node back before the server round-trips.
          node.x = pos.x;
          node.y = pos.y;
        }
        void send({ type: 'moveGraphNode', id: drag.id, x: pos.x, y: pos.y });
      }
      return;
    }
    if (!panning) return;
    panning = false;
    panStartBox = null;
    canvas.classList.remove('panning');
  });
}

// ── wiring + boot ─────────────────────────────────────────────────────────────

function wire(): void {
  $('tab-brain').addEventListener('click', () => {
    currentTab = 'brain';
    switchTab('brain');
  });
  $('tab-mcp').addEventListener('click', () => {
    currentTab = 'mcp';
    switchTab('mcp');
    void loadMcpTab();
  });
  $('tab-graph').addEventListener('click', () => {
    currentTab = 'graph';
    switchTab('graph');
    void loadGraph(true);
  });

  $('adapter-toggle').addEventListener('click', () => void toggleAdapter());

  $('mode-manual').addEventListener('click', () => setMode('manual'));
  $('mode-plan').addEventListener('click', () => setMode('plan'));
  $('mode-auto').addEventListener('click', () => setMode('auto'));

  $('list-server').addEventListener('change', (e) => void loadGoalOptionTools((e.target as HTMLSelectElement).value));

  $('prompt-send').addEventListener('click', () => void submitPrompt());
  $('prompt-input').addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      void submitPrompt();
    }
  });
}

async function boot(): Promise<void> {
  wire();
  wireGraphCanvas();
  setMode('manual');
  // One forced probe so the badge/health agree with what the panel shows, then
  // the poll keeps everything current while the panel is visible. Devtools
  // documents do not die like MV3 workers — a plain interval is correct here.
  void send({ type: 'probeNow' });
  await refreshNodes();
  setInterval(() => {
    if (document.hidden) return;
    void refreshNodes();
    // Keeps the standalone/paired surface split current if the user pairs or
    // unpairs while the panel is open (getState is a sub-ms local read).
    void refreshAdapterState();
    // Only while the Graph tab is showing — the pan/zoom viewBox survives a
    // refetch because renderGraph's fitted box only seeds it on tab entry.
    if (currentTab === 'graph') void loadGraph(false);
  }, PANEL_POLL_MS);

  await refreshAdapterState();
  await loadGoalOptionServers();
  await pollAgentStatus();
}

void boot();
