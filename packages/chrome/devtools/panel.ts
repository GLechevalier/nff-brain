// The Brain panel document: two tabs — Brain (a chat-style transcript with a
// Manual/Plan/Auto mode switch) and MCP (registered-connection management).
//
// A devtools panel lives as long as devtools is open, so unlike the service
// worker this document MAY hold module state (same as popup/main.ts). All HTTP
// goes through the service worker via messages — the pairing token never
// enters this realm, and this document makes zero network requests of its own.

import { agentAdapterById } from '../src/agentRegistry.js';
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
  showFieldError,
  switchTab,
  type ChatMode,
  type GraphViewBox,
  type McpListItem,
  type PanelTab,
  type TranscriptEntry,
} from './panelPaint.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const AGENT_STATUS_POLL_MS = 4000;
const CHAT_HISTORY_TURNS_MAX = 6;

let latestNodes: NodesResponse | null = null;
let mode: ChatMode = 'manual';
let transcript: TranscriptEntry[] = [];
let chatHistory: ChatTurn[] = [];
const mcpToolsByServer = new Map<string, McpToolDef[]>();
let mcpListItems: McpListItem[] = [];
let agentPollTimer: ReturnType<typeof setTimeout> | null = null;
let submitting = false;
let currentTab: PanelTab = 'brain';
let graphViewBox: GraphViewBox | null = null;
let panning = false;
let panStartClientX = 0;
let panStartClientY = 0;
let panStartBox: GraphViewBox | null = null;

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

async function refreshAdapterState(): Promise<void> {
  const reply = await send({ type: 'getState' });
  if (reply.type === 'state') paintAdapter(reply.state);
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
};

function paintTranscript(): void {
  renderTranscript(transcript, transcriptHandlers);
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

// ── submitting the prompt — branches on mode ─────────────────────────────────

function pushChatTurn(turn: ChatTurn): void {
  chatHistory.push(turn);
  chatHistory = chatHistory.slice(-CHAT_HISTORY_TURNS_MAX);
}

async function submitChat(message: string): Promise<void> {
  const reply = await send({ type: 'chatAsk', message, history: chatHistory });
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

  try {
    if (mode === 'manual') await submitChat(message);
    else await submitGoal(message);
  } finally {
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
  const fitted = renderGraph(latestGraphNodes, latestGraphEdges);
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
    if (!panning) return;
    panGraph(canvas, e.clientX - panStartClientX, e.clientY - panStartClientY);
  });

  window.addEventListener('mouseup', () => {
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
    // Only while the Graph tab is showing — the pan/zoom viewBox survives a
    // refetch because renderGraph's fitted box only seeds it on tab entry.
    if (currentTab === 'graph') void loadGraph(false);
  }, PANEL_POLL_MS);

  await refreshAdapterState();
  await loadGoalOptionServers();
  await pollAgentStatus();
}

void boot();
