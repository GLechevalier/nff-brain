// The consolidated side panel: ONE UI home with six subtabs —
// Setup · Agent · MCP · Brain · Graph · Settings. A side panel does NOT
// consume the active tab's debugger slot (unlike DevTools), so the CDP web
// agent can attach to the very page the user is looking at. It is also the
// toolbar icon's default click target now (chrome.sidePanel.setPanelBehavior
// in src/sw.ts) — there is no more separate toolbar popup, so Setup carries
// everything that surface used to own: pairing, capture, the allowed-domains
// list, recorders, and record-a-task.
//
// This document is a thin client: every message rides chrome.runtime to the
// service worker, and the pairing token / provider key never enter this realm.
// Because the side panel speaks the FULL popup message union (PanelToSw =
// PopupToSw, SwToPanel = SwToPopup in src/protocol.ts), the Brain/MCP/Graph
// flows ported from the old DevTools panel and the Settings flow ported from the
// old options page work here verbatim — the only substitution is tabId, which
// the DevTools panel read from chrome.devtools.inspectedWindow and this panel
// resolves via activeTabId() (the window's active tab).
//
// A side panel lives as long as it is open (like the old devtools/popup docs and
// unlike the MV3 service worker), so this document MAY hold module state.

import { agentAdapterById } from '../src/agentRegistry.js';
import { detectActionIntent, type ActionIntent } from '../src/actionIntent.js';
import { detectPageActionIntent } from '../src/pageActionIntent.js';
import { DEFAULT_PORT, PANEL_POLL_MS } from '../src/protocol.js';
import type {
  ChatTurn,
  GraphEdge,
  GraphNode,
  McpServerSummary,
  McpToolDef,
  NodesResponse,
  PopupToSw,
  PublicState,
  SwToPopup,
  WebAgentListTarget,
  WebAgentRun,
} from '../src/protocol.js';
import { adapterById } from '../src/recorderRegistry.js';
import type { ProviderId } from '@nff-brain/core/provider';
import {
  fillModelDatalists,
  hideClearConfirm,
  paintActRun,
  paintAdapter,
  paintClearConfirm,
  paintHeader,
  paintMcpServerOptions,
  paintMcpToolOptions,
  paintMode,
  paintSettings,
  paintSetup,
  renderGraph,
  renderMcpList,
  renderTranscript,
  renderWorkflows,
  setGraphViewBox,
  setNodePosition,
  showActError,
  showFieldError,
  switchTab,
  type ChatMode,
  type GraphHandlers,
  type GraphViewBox,
  type McpListItem,
  type SidePanelTab,
  type TranscriptEntry,
  type WorkflowRow,
} from './render.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const AGENT_STATUS_POLL_MS = 4000;
const CHAT_HISTORY_TURNS_MAX = 6;

// Cycling "waiting for a reply" words, shown in the Brain transcript between
// sending a prompt and the answer/plan/run entry landing.
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

// ── shared module state ───────────────────────────────────────────────────────

let currentTab: SidePanelTab = 'setup';
let latestNodes: NodesResponse | null = null;

// Setup tab
let latestState: PublicState | null = null;
let currentHost: string | null = null;

// Agent (CDP web agent) tab
let actPollTimer: ReturnType<typeof setTimeout> | null = null;

// Brain tab
let mode: ChatMode = 'manual';
let transcript: TranscriptEntry[] = [];
let chatHistory: ChatTurn[] = [];
const mcpToolsByServer = new Map<string, McpToolDef[]>();
let agentPollTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let submitting = false;

// MCP tab
let mcpListItems: McpListItem[] = [];

// Graph tab
let latestGraphNodes: GraphNode[] = [];
let latestGraphEdges: GraphEdge[] = [];
let graphViewBox: GraphViewBox | null = null;
let panning = false;
let panStartClientX = 0;
let panStartClientY = 0;
let panStartBox: GraphViewBox | null = null;
let nodeDrag: { id: string; startClientX: number; startClientY: number; x0: number; y0: number; moved: boolean } | null = null;

function send(msg: PopupToSw): Promise<SwToPopup> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToPopup) => {
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

/** The tab the agent should drive: the active tab of this panel's window. This
 *  replaces the DevTools panel's chrome.devtools.inspectedWindow.tabId. */
async function activeTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

/** Resolved fresh on every call rather than cached — unlike the old popup
 *  (which reopened per click), this panel can stay open across tab switches,
 *  so a cached host would go stale. */
async function resolveCurrentHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // activeTab grants url access only for the tab the panel's window is
    // showing, and never on chrome:// or Web Store pages — hence the graceful null.
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    return /^https?:$/.test(url.protocol) ? url.hostname : null;
  } catch {
    return null;
  }
}

// ── header + shared state refresh ─────────────────────────────────────────────

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
 * One getState fans out to every state-driven surface: the Brain adapter
 * toggle, the standalone-mode gating, and the Settings tab. Kept a single read
 * so a pair/unpair (or a key save elsewhere) reconciles the whole panel at
 * once — getState is a sub-ms local read.
 */
async function refreshState(): Promise<void> {
  const reply = await send({ type: 'getState' });
  if (reply.type !== 'state') return;
  latestState = reply.state;
  paintAdapter(reply.state);
  paintStandaloneMode(reply.state.phase === 'standalone');
  paintSettings(reply.state);
  paintSetup(reply.state, {
    currentHost,
    onRemoveRule: (host) => void dispatchSetup({ type: 'removeRule', host }),
    onToggleRecorder: (id, enable) => void toggleRecorder(id, enable),
  });
}

/** Setup tab's own dispatch: sends, repaints Setup on a state reply, and
 *  surfaces an error into the given field — same contract the old popup's
 *  dispatch() had. */
async function dispatchSetup(msg: PopupToSw, errorField?: string): Promise<boolean> {
  const reply = await send(msg);
  if (reply.type === 'error') {
    if (errorField) showFieldError(errorField, reply.message);
    return false;
  }
  if (errorField) showFieldError(errorField, null);
  if (reply.type === 'state') {
    latestState = reply.state;
    paintSetup(reply.state, {
      currentHost,
      onRemoveRule: (host) => void dispatchSetup({ type: 'removeRule', host }),
      onToggleRecorder: (id, enable) => void toggleRecorder(id, enable),
    });
  }
  return true;
}

/**
 * Standalone mode: Plan/Auto and the MCP tab are intrinsically server-backed
 * (web-agent state and MCP registry live in nff-brain serve), so they hide
 * rather than error. Agent/Brain(Manual)/Graph/Settings stay usable off the
 * local brain + BYOK key.
 */
function paintStandaloneMode(standalone: boolean): void {
  $('sp-tab-mcp').classList.toggle('hidden', standalone);
  $('mode-plan').classList.toggle('hidden', standalone);
  $('mode-auto').classList.toggle('hidden', standalone);
  $('adapter-row').classList.toggle('hidden', standalone);
  // Plan/Auto are paired-only; standalone keeps Manual (chat + navigate-intent).
  if (standalone && mode !== 'manual') setMode('manual');
  if (standalone && currentTab === 'mcp') {
    currentTab = 'brain';
    switchTab('brain');
  }
}

// ── Setup tab — ported from the old toolbar popup ────────────────────────────

/**
 * Enable runs HERE, not in the SW: chrome.permissions.request needs a user
 * gesture, and this click is that gesture. Only a granted permission flips
 * the recorder on; a denied prompt leaves everything off.
 */
async function toggleRecorder(id: string, enable: boolean): Promise<void> {
  if (!enable) {
    await dispatchSetup({ type: 'setRecorderEnabled', id, enabled: false }, 'setup-recorder-error');
    return;
  }
  const adapter = adapterById(id);
  if (!adapter) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: adapter.originPatterns });
  } catch {
    granted = false;
  }
  if (!granted) {
    showFieldError('setup-recorder-error', `Chrome permission for ${adapter.hosts.join(', ')} was not granted — the recorder stays off.`);
    return;
  }
  await dispatchSetup({ type: 'setRecorderEnabled', id, enabled: true }, 'setup-recorder-error');
}

function paintTrace(recording: boolean, eventCount: number, pending: { events: number; startUrl: string } | null): void {
  const btn = $('setup-trace-toggle') as HTMLButtonElement;
  btn.textContent = recording ? 'Stop recording' : 'Record this tab';
  btn.classList.toggle('primary', recording);
  $('setup-trace-count').textContent = recording ? `${eventCount} events` : '';
  const pend = $('setup-trace-pending');
  if (pending && !recording) {
    pend.textContent = `Last recording: ${pending.events} events — distilling into a workflow.`;
    pend.classList.remove('hidden');
  } else {
    pend.classList.add('hidden');
  }
}

async function refreshTrace(): Promise<void> {
  const reply = await send({ type: 'getTraceStatus' });
  if (reply.type === 'traceStatus') paintTrace(reply.recording, reply.eventCount, reply.pending);
}

async function toggleTrace(): Promise<void> {
  showFieldError('setup-trace-error', null);
  const status = await send({ type: 'getTraceStatus' });
  const recording = status.type === 'traceStatus' && status.recording;
  if (recording) {
    const reply = await send({ type: 'traceStop' });
    if (reply.type === 'traceStatus') paintTrace(reply.recording, reply.eventCount, reply.pending);
    return;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showFieldError('setup-trace-error', 'Could not find the current tab.');
    return;
  }
  const reply = await send({ type: 'traceStart', tabId });
  if (reply.type === 'error') {
    showFieldError('setup-trace-error', reply.message);
    return;
  }
  if (reply.type === 'traceStatus') paintTrace(reply.recording, reply.eventCount, reply.pending);
}

// ── tab selection ─────────────────────────────────────────────────────────────

function selectTab(tab: SidePanelTab): void {
  currentTab = tab;
  switchTab(tab);
  if (tab === 'mcp') void loadMcpTab();
  if (tab === 'graph') void loadGraph(true);
  if (tab === 'settings') void refreshState();
  if (tab === 'setup') {
    void resolveCurrentHost().then((host) => {
      currentHost = host;
      void refreshState();
    });
    void refreshTrace();
  }
}

// The web agent now lives inside the Brain tab's "Act" mode (default), so its
// grant/status/log render there. Standalone gating for 'mcp' still applies.

// ── Agent tab (CDP web agent) ─────────────────────────────────────────────────

function scheduleActPoll(ms: number): void {
  if (actPollTimer) clearTimeout(actPollTimer);
  actPollTimer = setTimeout(() => void pollActStatus(), ms);
}

async function pollActStatus(): Promise<void> {
  const reply = await send({ type: 'getActStatus' });
  if (reply.type !== 'actStatus') return;
  paintActRun(reply.run);
  const live =
    reply.run && (reply.run.phase === 'running' || reply.run.phase === 'stopping' || reply.run.phase === 'awaiting_grant');
  if (live) scheduleActPoll(1000);
}

async function startActRun(goal: string, workflowId?: string, maxActionsOverride?: number): Promise<void> {
  showActError(null);
  if (!goal) {
    showActError('Describe a task first.');
    return;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showActError('Could not find the active tab in this window.');
    return;
  }
  const maxActions = maxActionsOverride ?? (Number(($('act-budget') as HTMLInputElement).value) || undefined);
  const reply = await send({ type: 'actStart', goal, tabId, maxActions, workflowId });
  if (reply.type === 'error') {
    showActError(reply.message);
    return;
  }
  if (reply.type === 'actStatus') paintActRun(reply.run);
  scheduleActPoll(600);
}

async function grantAct(choice: 'once' | 'always' | 'never'): Promise<void> {
  const reply = await send({ type: 'actGrant', choice });
  if (reply.type === 'actStatus') paintActRun(reply.run);
  scheduleActPoll(600);
}

async function stopActRun(): Promise<void> {
  const reply = await send({ type: 'actStop' });
  if (reply.type === 'actStatus') paintActRun(reply.run);
  scheduleActPoll(600);
}

async function clearActRun(): Promise<void> {
  const reply = await send({ type: 'actEnd' });
  if (reply.type === 'actStatus') paintActRun(reply.run);
}

async function loadWorkflows(): Promise<void> {
  const reply = await send({ type: 'getWorkflows' });
  if (reply.type !== 'workflows') return;
  renderWorkflows(reply.items, (w: WorkflowRow) => {
    // Replaying a recorded workflow runs the CDP agent; the run-feedback area
    // (act-run) appears while it works.
    void startActRun(w.intent, w.id);
  });
}

// ── Brain tab: LinkedIn adapter toggle ───────────────────────────────────────

/**
 * Enable runs HERE, not in the SW: chrome.permissions.request needs a user
 * gesture, and this click is that gesture. A denied prompt leaves the agent off.
 */
async function toggleAdapter(): Promise<void> {
  const adapter = agentAdapterById('linkedin');
  if (!adapter) return;

  const stateReply = await send({ type: 'getState' });
  const enabled =
    stateReply.type === 'state' && stateReply.state.agentAdapters.find((a) => a.id === 'linkedin')?.enabled === true;

  if (enabled) {
    await send({ type: 'setAgentAdapterEnabled', id: 'linkedin', enabled: false });
    await refreshState();
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
  await refreshState();
}

// ── Brain tab: mode switch ────────────────────────────────────────────────────

function setMode(next: ChatMode): void {
  mode = next;
  paintMode(mode);
}

// ── Brain tab: goal-options selects (Plan/Auto mode's "add matches to") ──────

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

// ── Brain tab: the transcript's run/plan entries ─────────────────────────────

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
  onStopRun: (runId: string) => void stopAgentRun(runId),
  onPermissionDecision: (requestId: string, decision: 'yes' | 'no' | 'always') => void resolvePermission(requestId, decision),
};

function paintTranscript(): void {
  renderTranscript(transcript, transcriptHandlers);
}

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

function findRunEntry(runId: string): Extract<TranscriptEntry, { kind: 'plan' | 'run' }> | undefined {
  return transcript.find((e): e is Extract<TranscriptEntry, { kind: 'plan' | 'run' }> => (e.kind === 'plan' || e.kind === 'run') && e.runId === runId);
}

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

async function stopAgentRun(runId: string): Promise<void> {
  const reply = await send({ type: 'agentStop', runId });
  if (reply.type === 'agentStatus' && reply.run) applyRunUpdate(reply.run);
}

// ── Brain tab: Manual-mode chat's action-intent permission prompt ────────────

function findPermissionEntry(requestId: string): Extract<TranscriptEntry, { kind: 'permission' }> | undefined {
  return transcript.find((e): e is Extract<TranscriptEntry, { kind: 'permission' }> => e.kind === 'permission' && e.requestId === requestId);
}

async function resolvePermission(requestId: string, decision: 'yes' | 'no' | 'always'): Promise<void> {
  const entry = findPermissionEntry(requestId);
  if (!entry) return;
  entry.decision = decision;
  paintTranscript();

  if (decision === 'no') return;
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showFieldError('prompt-error', 'Could not find the active tab in this window.');
    return;
  }
  if (entry.target.kind === 'adapter') {
    if (decision === 'always') await send({ type: 'setAgentActionAllowed', adapterId: entry.target.adapterId, allowed: true });
    await send({ type: 'runAdapterNavigate', adapterId: entry.target.adapterId, tabId });
  } else {
    if (decision === 'always') await send({ type: 'setNavigateHostAllowed', host: entry.target.host, allowed: true });
    await send({ type: 'runNavigateHost', url: entry.url, tabId });
  }
}

// ── Brain tab: submitting the prompt — branches on mode ──────────────────────

function pushChatTurn(turn: ChatTurn): void {
  chatHistory.push(turn);
  chatHistory = chatHistory.slice(-CHAT_HISTORY_TURNS_MAX);
}

async function submitChat(message: string): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showFieldError('prompt-error', 'Could not find the active tab in this window.');
    return;
  }
  const reply = await send({ type: 'chatAsk', message, history: chatHistory, tabId });
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
 * The action-intent shortcut — checked BEFORE mode branching, in EVERY mode, so
 * "navigate to linkedin" never gets misread as a recruiting goal. A match skips
 * chatAsk/agentSubmitGoal entirely. Auto mode opens immediately; Manual and Plan
 * still ask.
 */
async function submitActionIntent(intent: ActionIntent): Promise<void> {
  if (intent.kind === 'history') {
    const tabId = await activeTabId();
    if (tabId === undefined) {
      showFieldError('prompt-error', 'Could not find the active tab in this window.');
      return;
    }
    const reply = await send({ type: 'runNavigateHistory', direction: intent.direction, tabId });
    if (reply.type === 'error') {
      showFieldError('prompt-error', reply.message);
      return;
    }
    transcript.push({
      kind: 'answer',
      text: intent.direction === 'back' ? '← Went back' : '→ Went forward',
      sources: [],
    });
    paintTranscript();
    return;
  }

  const target: Extract<TranscriptEntry, { kind: 'permission' }>['target'] =
    intent.kind === 'adapter' ? { kind: 'adapter', adapterId: intent.adapterId } : { kind: 'host', host: intent.host };

  const stateReply = await send({ type: 'getState' });
  const alwaysAllowed =
    stateReply.type === 'state' &&
    (target.kind === 'adapter'
      ? stateReply.state.agentActionAllow.includes(target.adapterId)
      : stateReply.state.navigateHostAllow.includes(target.host));

  if (alwaysAllowed || mode === 'auto') {
    const tabId = await activeTabId();
    if (tabId === undefined) {
      showFieldError('prompt-error', 'Could not find the active tab in this window.');
      return;
    }
    if (target.kind === 'adapter') await send({ type: 'runAdapterNavigate', adapterId: target.adapterId, tabId });
    else await send({ type: 'runNavigateHost', url: intent.url, tabId });
    transcript.push({
      kind: 'permission',
      requestId: crypto.randomUUID(),
      target,
      label: intent.label,
      url: intent.url,
      decision: alwaysAllowed ? 'always' : 'yes',
    });
    paintTranscript();
    return;
  }

  transcript.push({ kind: 'permission', requestId: crypto.randomUUID(), target, label: intent.label, url: intent.url });
  paintTranscript();
}

// A one-off click/scroll/type instruction from chat needs far less budget
// than a multi-step recruiting goal or workflow replay (whose #act-budget
// field defaults to 40) — read_page + one interact + maybe a re-check.
const MANUAL_PAGE_ACTION_MAX_ACTIONS = 6;

/**
 * Manual-mode chat's "click the X button" shortcut. Reuses the CDP web
 * agent's existing run/grant machinery (startActRun/#act-run/#act-grant)
 * unchanged — the permission prompt and progress log render in the Saved
 * workflows panel exactly as they do for a workflow replay; the chat only
 * gets a short pointer to it. nb.actRun is a single global run, so this
 * refuses to start a second one on top of an already-active run instead of
 * silently clobbering it.
 */
async function submitPageAction(instruction: string): Promise<void> {
  const statusReply = await send({ type: 'getActStatus' });
  const activeRun =
    statusReply.type === 'actStatus' &&
    statusReply.run &&
    (statusReply.run.phase === 'running' || statusReply.run.phase === 'awaiting_grant' || statusReply.run.phase === 'stopping');
  if (activeRun) {
    showFieldError('prompt-error', 'a run is already in progress below — stop or clear it first');
    return;
  }

  await startActRun(instruction, undefined, MANUAL_PAGE_ACTION_MAX_ACTIONS);
  transcript.push({ kind: 'answer', text: 'Working on it — see the run below.', sources: [] });
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
    const pageAction = mode === 'manual' && !intent ? detectPageActionIntent(message) : null;
    if (intent) await submitActionIntent(intent);
    else if (pageAction) await submitPageAction(pageAction.instruction);
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

/**
 * resetView is true only on tab entry — a poll refresh must rebuild the
 * node/edge SVG (data may have changed) without discarding the user's current
 * pan/zoom, so it re-applies the preserved viewBox after rendering.
 */
async function loadGraph(resetView: boolean): Promise<void> {
  const reply = await send({ type: 'getGraph' });
  if (reply.type !== 'graph') {
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
// click — a trivial jiggle still must not fire a network write.
const NODE_DRAG_THRESHOLD_PX = 3;

function dragNode(canvas: HTMLElement, clientX: number, clientY: number): { x: number; y: number } | null {
  if (!nodeDrag || !graphViewBox) return null;
  const rect = canvas.getBoundingClientRect();
  const dxClient = clientX - nodeDrag.startClientX;
  const dyClient = clientY - nodeDrag.startClientY;
  if (Math.abs(dxClient) + Math.abs(dyClient) > NODE_DRAG_THRESHOLD_PX) nodeDrag.moved = true;
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

// ── Settings tab (BYOK provider) ──────────────────────────────────────────────

function selectedProvider(): ProviderId {
  return ($('provider') as HTMLSelectElement).value as ProviderId;
}

async function saveKey(): Promise<void> {
  const input = $('api-key') as HTMLInputElement;
  const apiKey = input.value.trim();
  if (!apiKey) {
    showFieldError('key-error', 'paste a key first');
    return;
  }
  const reply = await send({ type: 'setProvider', provider: selectedProvider(), apiKey });
  if (reply.type === 'error') {
    showFieldError('key-error', reply.message);
    return;
  }
  showFieldError('key-error', null);
  input.value = ''; // the key never lingers in the DOM
  await refreshState();
}

async function clearKey(): Promise<void> {
  const reply = await send({ type: 'clearProvider' });
  if (reply.type === 'error') {
    showFieldError('key-error', reply.message);
    return;
  }
  showFieldError('key-error', null);
  ($('api-key') as HTMLInputElement).value = '';
  await refreshState();
}

async function saveModels(): Promise<void> {
  const background = ($('model-background') as HTMLInputElement).value.trim();
  const chat = ($('model-chat') as HTMLInputElement).value.trim();
  const reply = await send({ type: 'setProviderModels', models: { background, chat } });
  showFieldError('models-error', reply.type === 'error' ? reply.message : null);
  if (reply.type !== 'error') await refreshState();
}

async function testConnection(): Promise<void> {
  const el = $('test-result');
  el.classList.remove('hidden', 'ok', 'error');
  el.textContent = 'Testing…';
  const reply = await send({ type: 'testProvider' });
  if (reply.type === 'providerTest') {
    el.textContent = reply.result.message;
    el.classList.add(reply.result.ok ? 'ok' : 'error');
  } else {
    el.textContent = reply.type === 'error' ? reply.message : 'test failed';
    el.classList.add('error');
  }
  await refreshState();
}

// ── wiring + boot ─────────────────────────────────────────────────────────────

function wire(): void {
  // Tabs
  $('sp-tab-setup').addEventListener('click', () => selectTab('setup'));
  $('sp-tab-brain').addEventListener('click', () => selectTab('brain'));
  $('sp-tab-mcp').addEventListener('click', () => selectTab('mcp'));
  $('sp-tab-graph').addEventListener('click', () => selectTab('graph'));
  $('sp-tab-settings').addEventListener('click', () => selectTab('settings'));

  // Setup tab — pairing, capture, allowlist, recorders, record-a-task.
  $('setup-retry').addEventListener('click', () => void dispatchSetup({ type: 'probeNow' }));
  $('setup-connect').addEventListener('click', () => {
    const port = Number(($('setup-port') as HTMLInputElement).value || DEFAULT_PORT);
    const code = ($('setup-code') as HTMLInputElement).value;
    void dispatchSetup({ type: 'pair', port, code }, 'setup-pair-error');
  });
  $('setup-code').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') $('setup-connect').click();
  });
  $('setup-capture-toggle').addEventListener('click', () => {
    void dispatchSetup({ type: 'setCaptureEnabled', enabled: !(latestState?.capture.enabled ?? false) });
  });
  const addSetupRule = () => {
    const input = $('setup-rule-input') as HTMLInputElement;
    void dispatchSetup({ type: 'addRule', input: input.value }, 'setup-rule-error').then((ok) => {
      if (ok) input.value = '';
    });
  };
  $('setup-rule-add').addEventListener('click', addSetupRule);
  $('setup-rule-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addSetupRule();
  });
  $('setup-allow-current').addEventListener('click', () => {
    if (currentHost) void dispatchSetup({ type: 'addRule', input: currentHost }, 'setup-rule-error');
  });
  $('setup-clear').addEventListener('click', () => {
    if (latestState) paintClearConfirm(latestState);
  });
  $('setup-clear-no').addEventListener('click', hideClearConfirm);
  $('setup-clear-yes').addEventListener('click', () => {
    const alsoRemoveNodes = ($('setup-clear-nodes') as HTMLInputElement).checked;
    void dispatchSetup({ type: 'clearActivity', alsoRemoveNodes }).then(hideClearConfirm);
  });
  $('setup-trace-toggle').addEventListener('click', () => void toggleTrace());

  // Brain tab — Claude-Code-style modes. The act Stop/Clear/grant controls drive
  // a REPLAYED workflow (record-and-automate), shown in the workflows section.
  $('mode-manual').addEventListener('click', () => setMode('manual'));
  $('mode-plan').addEventListener('click', () => setMode('plan'));
  $('mode-auto').addEventListener('click', () => setMode('auto'));
  $('act-stop').addEventListener('click', () => void stopActRun());
  $('act-clear').addEventListener('click', () => void clearActRun());
  $('act-grant-once').addEventListener('click', () => void grantAct('once'));
  $('act-grant-always').addEventListener('click', () => void grantAct('always'));
  $('act-grant-never').addEventListener('click', () => void grantAct('never'));

  $('adapter-toggle').addEventListener('click', () => void toggleAdapter());
  $('list-server').addEventListener('change', (e) => void loadGoalOptionTools((e.target as HTMLSelectElement).value));
  $('prompt-send').addEventListener('click', () => void submitPrompt());
  $('prompt-input').addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      void submitPrompt();
    }
  });

  // Settings tab
  $('provider').addEventListener('change', () => fillModelDatalists(selectedProvider()));
  $('key-save').addEventListener('click', () => void saveKey());
  $('api-key').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void saveKey();
  });
  // A saved key renders as a masked, read-only placeholder (see paintSettings).
  // Focusing it means "replace the key" — clear it back to an editable box
  // rather than letting the masked dots be typed over or accidentally saved.
  $('api-key').addEventListener('focus', () => {
    const input = $('api-key') as HTMLInputElement;
    if (input.readOnly) {
      input.readOnly = false;
      input.value = '';
    }
  });
  $('key-clear').addEventListener('click', () => void clearKey());
  $('models-save').addEventListener('click', () => void saveModels());
  $('test').addEventListener('click', () => void testConnection());

  // The SW pushes storage changes; reconcile the Agent run/workflows and the
  // shared state (header/adapter/standalone/Setup/settings) when it does.
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area !== 'local') return;
    void pollActStatus();
    void loadWorkflows();
    void refreshState();
    void refreshNodes();
    void refreshTrace();
  });
}

async function boot(): Promise<void> {
  ($('setup-port') as HTMLInputElement).value = String(DEFAULT_PORT);
  wire();
  wireGraphCanvas();
  setMode('manual'); // Claude-Code-style default

  // Agent is the panel's landing tab — the icon opens straight into the chat
  // + web-agent view now that there is no separate toolbar popup to greet the
  // user first. Assigned through a SidePanelTab-typed local (not the 'brain'
  // literal directly) so TS keeps tracking currentTab as the full union below,
  // not the literal — it can genuinely change before the awaits later in this
  // function settle (e.g. selectTab() firing from a click on a tab entry itself).
  const initialTab: SidePanelTab = 'brain';
  currentTab = initialTab;
  switchTab(initialTab);

  // One forced probe so the badge/health agree with what the panel shows, then
  // the poll keeps everything current while the panel is visible.
  void send({ type: 'probeNow' });
  currentHost = await resolveCurrentHost();
  await refreshNodes();
  await refreshState(); // may re-gate the initial tab if standalone
  void refreshTrace();
  await loadGoalOptionServers();
  await pollAgentStatus();
  await pollActStatus();
  await loadWorkflows();

  setInterval(() => {
    if (document.hidden) return;
    void refreshNodes();
    void refreshState();
    if (currentTab === 'graph') void loadGraph(false);
  }, PANEL_POLL_MS);
}

void boot();
