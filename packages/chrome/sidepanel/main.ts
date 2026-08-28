// The consolidated side panel: ONE UI home with five subtabs —
// Settings · Agent · MCP · Brain · Graph (the Settings tab is still 'setup'
// in ids/JS identifiers below; only the visible label changed). A side panel
// does NOT consume the active tab's debugger slot (unlike DevTools), so the
// CDP web agent can attach to the very page the user is looking at. It is
// also the toolbar icon's default click target now
// (chrome.sidePanel.setPanelBehavior in src/sw.ts) — there is no more
// separate toolbar popup or options page, so Settings carries everything
// those surfaces used to own: pairing, capture, the allowed-domains list,
// recorders, record-a-task, and the BYOK fallback key.
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

import { detectActionIntent, type ActionIntent } from '../src/actionIntent.js';
import { detectPageActionIntent } from '../src/pageActionIntent.js';
import { CRM_ORIGIN_PATTERN, DEFAULT_PORT, PANEL_POLL_MS } from '../src/protocol.js';
import type {
  ChatTurn,
  GraphEdge,
  GraphNode,
  McpServerSummary,
  NodesResponse,
  PopupToSw,
  PublicState,
  SwToPopup,
  WebAgentRun,
} from '../src/protocol.js';
import { adapterById } from '../src/recorderRegistry.js';
import { getProjectHandle, putProjectHandle } from '../src/fsHandles.js';
import type { ActRunState } from '../src/schema.js';
import type { ProviderId } from '@nff-brain/core/provider';
import {
  fillModelDatalists,
  hideClearConfirm,
  paintActRun,
  paintClearConfirm,
  paintHeader,
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

// Action-flavored counterpart to PENDING_WORDS, cycled while the WEB AGENT is
// actually working — in the transcript's run entries, the act status line, and
// (for chat-launched page actions) the pending bubble, which stays alive for
// the WHOLE run rather than just the dispatch round-trip.
const WORKING_WORDS = [
  'Fulminating…',
  'Working on it…',
  'Scheming…',
  'Plotting the next move…',
  'Peering at the page…',
  'Lining things up…',
  'Nudging pixels…',
  'Double-checking…',
];

// When the act run's latest transcript line tells us what the agent just did,
// alternate that in with the whimsy ("Reading the page…" beats "Fulminating…"
// for half the ticks). Patterns match executeVerb()'s resultText strings.
const ACTIVITY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/read \d+ interactive/, 'Reading the page…'],
  [/click/i, 'Clicking…'],
  [/\btyped\b|\bpressed\b/, 'Typing…'],
  [/scroll/i, 'Scrolling…'],
  [/\bloaded\b|navigating|went back|went forward|reloaded/, 'Navigating…'],
  [/dragged|moved to/, 'Moving the mouse…'],
  [/\btab\b/i, 'Juggling tabs…'],
];

// ── shared module state ───────────────────────────────────────────────────────

let currentTab: SidePanelTab = 'setup';
let latestNodes: NodesResponse | null = null;

// Settings tab
let latestState: PublicState | null = null;
let currentHost: string | null = null;

// Agent (CDP web agent) tab
let actPollTimer: ReturnType<typeof setTimeout> | null = null;

// Brain tab
let mode: ChatMode = 'manual';
let transcript: TranscriptEntry[] = [];
let chatHistory: ChatTurn[] = [];
let agentPollTimer: ReturnType<typeof setTimeout> | null = null;
let submitting = false;
// The ONE 2s word ticker behind every rotating status word (pending bubble,
// run-entry phase label, act status line). Self-stops when nothing is live.
let workingTimer: ReturnType<typeof setInterval> | null = null;
let workingWordIndex = Math.floor(Math.random() * WORKING_WORDS.length);
// Last act-run state seen, so the ticker can repaint the act status line
// between polls and workingWord() can sniff the latest activity.
let lastActRun: ActRunState | null = null;
// Set when the chat's pending bubble should outlive submitPrompt() and track
// a page-action act run instead — cleared by pollActStatus() on a terminal run.
let pendingFollowsActRun = false;

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
let selectedGraphNodeId: string | null = null;

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
  if (reply.type !== 'nodes') return;
  latestNodes = reply.data;
}

/**
 * One getState fans out to every state-driven surface: the Brain adapter
 * toggle, the unpaired-gating, the Settings tab's fallback-key section, and
 * (via paintHeader) the global connection banner — kept here rather than in
 * refreshNodes() because
 * only getState carries the real ConnectionPhase; refreshNodes only ever had
 * a success/failure boolean, which can't tell "disconnected" apart from
 * "workspace_mismatch" (a materially different situation — the brain IS
 * reachable, it's just paired to a different project). Single read so a
 * pair/unpair (or a key save elsewhere) reconciles the whole panel at once —
 * getState is a sub-ms local read.
 */
async function refreshState(): Promise<void> {
  const reply = await send({ type: 'getState' });
  if (reply.type !== 'state') return;
  latestState = reply.state;
  paintHeader(latestNodes, reply.state.phase, reply.state.brainMode);
  paintCapabilityGate(reply.state);
  paintSettings(reply.state);
  paintSetup(reply.state, {
    currentHost,
    onRemoveRule: (host) => void dispatchSetup({ type: 'removeRule', host }),
    onToggleRecorder: (id, enable) => void toggleRecorder(id, enable),
  });
}

/** Settings tab's own dispatch: sends, repaints Setup on a state reply, and
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
 * Two separate gates, because they answer different questions. The MCP tab is
 * intrinsically server-backed (the registry lives in nff-brain serve), so it
 * hides while the server isn't connected. The Plan/Auto autonomy modes only
 * need SOME reasoning backend — paired server OR a direct API key (mode.ts) —
 * so they unlock whenever one is configured; per-origin action grants
 * (actGate) still apply in every mode. Only with no backend at all does the
 * panel force Manual.
 */
function paintCapabilityGate(state: PublicState): void {
  const mcpGated = state.phase !== 'connected';
  const modesGated = state.brainMode === 'unconfigured';
  $('sp-tab-mcp').classList.toggle('hidden', mcpGated);
  $('mode-plan').classList.toggle('hidden', modesGated);
  $('mode-auto').classList.toggle('hidden', modesGated);
  if (modesGated && mode !== 'manual') setMode('manual');
  if (mcpGated && currentTab === 'mcp') {
    currentTab = 'brain';
    switchTab('brain');
  }
}

// ── Settings tab — ported from the old toolbar popup ──────────────────────────

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

/**
 * Same gesture rule as toggleRecorder: chrome.permissions.request must run in
 * this click handler. The secret is sent inbound once and the field cleared —
 * it is never painted back (see paintCrmSync).
 */
async function saveCrmSecret(): Promise<void> {
  const input = $('crm-sync-secret') as HTMLInputElement;
  const secret = input.value.trim();
  if (!secret) {
    showFieldError('crm-sync-error', 'paste the ingest secret first');
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [CRM_ORIGIN_PATTERN] });
  } catch {
    granted = false;
  }
  if (!granted) {
    showFieldError('crm-sync-error', 'Chrome permission for admin.nanoforgeflow.com was not granted — CRM sync stays off.');
    return;
  }
  const ok = await dispatchSetup({ type: 'setCrmSyncSecret', secret }, 'crm-sync-error');
  if (ok) input.value = '';
  await refreshState();
}

/**
 * Company brain sync — same gesture rule (chrome.permissions.request in the
 * click handler) and same write-only token posture as saveCrmSecret. The host
 * grant is shared with CRM sync (one origin covers both).
 */
async function saveBrainSyncToken(): Promise<void> {
  const input = $('brain-sync-token') as HTMLInputElement;
  const token = input.value.trim();
  if (!token) {
    showFieldError('brain-sync-error', 'paste your sync token first');
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [CRM_ORIGIN_PATTERN] });
  } catch {
    granted = false;
  }
  if (!granted) {
    showFieldError('brain-sync-error', 'Chrome permission for admin.nanoforgeflow.com was not granted — company sync stays off.');
    return;
  }
  const ok = await dispatchSetup({ type: 'setBrainSyncToken', token }, 'brain-sync-error');
  if (ok) input.value = '';
  await refreshState();
}

async function brainSyncNow(): Promise<void> {
  const btn = $('brain-sync-now') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const reply = await send({ type: 'brainSyncNow' });
    if (reply.type === 'brainSyncResult') {
      showFieldError('brain-sync-error', reply.ok ? null : reply.message);
      $('brain-sync-status').textContent = reply.ok ? `Synced just now — ${reply.message}` : 'Sync failed';
    } else if (reply.type === 'error') {
      showFieldError('brain-sync-error', reply.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
    await refreshState();
  }
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
  paintAct(reply.run);
  const live =
    reply.run && (reply.run.phase === 'running' || reply.run.phase === 'stopping' || reply.run.phase === 'awaiting_grant');
  // A chat-launched page action keeps its pending bubble rotating for the
  // whole run; land the closing answer when the run reaches a terminal phase.
  if (pendingFollowsActRun && !live) {
    pendingFollowsActRun = false;
    clearPending();
    const r = reply.run;
    const text =
      r?.phase === 'error'
        ? `That didn't work: ${r.error ?? 'unknown error'} — details in the run log below.`
        : r?.phase === 'stopped'
          ? 'Stopped — see the run log below.'
          : 'Done — see the run log below.';
    transcript.push({ kind: 'answer', text, sources: [] });
    paintTranscript();
  }
  if (live) scheduleActPoll(1000);
}

async function startActRun(goal: string, workflowId?: string, maxActionsOverride?: number): Promise<boolean> {
  showActError(null);
  if (!goal) {
    showActError('Describe a task first.');
    return false;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showActError('Could not find the active tab in this window.');
    return false;
  }
  const maxActions = maxActionsOverride ?? (Number(($('act-budget') as HTMLInputElement).value) || undefined);
  const reply = await send({ type: 'actStart', goal, tabId, maxActions, workflowId, mode, codeEnabled: codeToolsEnabled() });
  if (reply.type === 'error') {
    showActError(reply.message);
    return false;
  }
  if (reply.type === 'actStatus') paintAct(reply.run);
  // The auto-approve toggle is per run — arm the fresh run when it's checked.
  if (codeToolsEnabled() && ($('code-auto') as HTMLInputElement).checked) void send({ type: 'codeAutoApprove', enabled: true });
  scheduleActPoll(600);
  return true;
}

async function grantAct(choice: 'once' | 'always' | 'never'): Promise<void> {
  const reply = await send({ type: 'actGrant', choice });
  if (reply.type === 'actStatus') paintAct(reply.run);
  scheduleActPoll(600);
}

async function stopActRun(): Promise<void> {
  const reply = await send({ type: 'actStop' });
  if (reply.type === 'actStatus') paintAct(reply.run);
  scheduleActPoll(600);
}

async function clearActRun(): Promise<void> {
  const reply = await send({ type: 'actEnd' });
  if (reply.type === 'actStatus') paintAct(reply.run);
}

// ── coding agent: project folder attach + approvals ──────────────────────────
//
// The picker and the permission re-request MUST run in this document (user
// gesture in a window context); the handle goes straight to IndexedDB
// (src/fsHandles.ts) and the SW is only told the JSON metadata.

function paintCodeProject(project: { name: string } | null, permission: string): void {
  const attached = !!project;
  $('code-attach').classList.toggle('hidden', attached);
  $('code-chip').classList.toggle('hidden', !attached);
  $('code-detach').classList.toggle('hidden', !attached);
  $('code-regrant').classList.toggle('hidden', !attached || permission === 'granted');
  $('code-enable-row').classList.toggle('hidden', !attached);
  $('code-auto-row').classList.toggle('hidden', !attached);
  if (project) {
    $('code-chip').textContent =
      permission === 'granted' ? `📁 ${project.name}` : `📁 ${project.name} (access needed)`;
  }
}

async function refreshCodeStatus(): Promise<void> {
  const reply = await send({ type: 'getCodeStatus' });
  if (reply.type === 'codeStatus') paintCodeProject(reply.project, reply.permission);
}

async function attachProject(): Promise<void> {
  $('code-error').classList.add('hidden');
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return; // user cancelled the picker — not an error
  }
  try {
    await putProjectHandle(handle);
  } catch {
    $('code-error').textContent = 'could not store the folder handle';
    $('code-error').classList.remove('hidden');
    return;
  }
  const reply = await send({ type: 'codeAttached', name: handle.name });
  if (reply.type === 'codeStatus') paintCodeProject(reply.project, reply.permission);
}

async function regrantProject(): Promise<void> {
  const handle = await getProjectHandle();
  if (!handle) return refreshCodeStatus();
  try {
    await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    // fall through — the status refresh below shows whatever state we're in
  }
  await refreshCodeStatus();
}

async function detachProject(): Promise<void> {
  const reply = await send({ type: 'codeDetach' });
  if (reply.type === 'codeStatus') paintCodeProject(reply.project, reply.permission);
}

/** Whether the next act run should carry the code tools. */
function codeToolsEnabled(): boolean {
  return !$('code-enable-row').classList.contains('hidden') && ($('code-enabled') as HTMLInputElement).checked;
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

// ── Brain tab: mode switch ────────────────────────────────────────────────────

function setMode(next: ChatMode): void {
  mode = next;
  paintMode(mode);
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
  renderTranscript(transcript, transcriptHandlers, workingWord());
}

/** What the agent is (most recently) up to, sniffed from the freshest signal
 *  available, or null when we can't tell and pure whimsy should rotate. */
function currentActivityLabel(): string | null {
  // CDP act run: the newest action/result transcript line describes it.
  if (lastActRun && (lastActRun.phase === 'running' || lastActRun.phase === 'stopping')) {
    for (let i = lastActRun.transcript.length - 1; i >= 0; i--) {
      const e = lastActRun.transcript[i];
      if (e.kind !== 'action' && e.kind !== 'result') continue;
      for (const [re, label] of ACTIVITY_WORDS) if (re.test(e.text)) return label;
      break;
    }
  }
  // Brain-tab web-agent run: the newest history record names its verb.
  const runEntry = transcript.find(
    (e): e is Extract<TranscriptEntry, { kind: 'run' }> => e.kind === 'run' && !isTerminalAgentPhase(e.run.phase),
  );
  const verb = runEntry?.run.history[runEntry.run.history.length - 1]?.verb;
  if (verb) {
    if (/read/i.test(verb)) return 'Reading the page…';
    if (/click|connect/i.test(verb)) return 'Clicking…';
    if (/navigate/i.test(verb)) return 'Navigating…';
  }
  return null;
}

/** The rotating status word for THIS tick — activity-aware on even ticks. */
function workingWord(): string {
  const activity = workingWordIndex % 2 === 0 ? currentActivityLabel() : null;
  return activity ?? WORKING_WORDS[workingWordIndex % WORKING_WORDS.length];
}

function workingTickerNeeded(): boolean {
  const pendingExists = transcript.some((e) => e.kind === 'pending');
  const liveRunEntry = transcript.some(
    (e) => (e.kind === 'run' || e.kind === 'plan') && !isTerminalAgentPhase(e.run.phase) && e.run.phase !== 'awaiting_approval',
  );
  const liveAct = !!lastActRun && (lastActRun.phase === 'running' || lastActRun.phase === 'stopping');
  return pendingExists || liveRunEntry || liveAct;
}

function ensureWorkingTicker(): void {
  if (workingTimer) return;
  workingTimer = setInterval(() => {
    if (!workingTickerNeeded()) {
      if (workingTimer) clearInterval(workingTimer);
      workingTimer = null;
      return;
    }
    workingWordIndex++;
    const entry = transcript.find((e): e is Extract<TranscriptEntry, { kind: 'pending' }> => e.kind === 'pending');
    // While the bubble tracks a live act run it speaks agent (WORKING_WORDS /
    // activity); while waiting on a chat reply it keeps the brain flavor.
    if (entry) entry.word = pendingFollowsActRun ? workingWord() : PENDING_WORDS[workingWordIndex % PENDING_WORDS.length];
    paintTranscript();
    paintAct(lastActRun);
  }, PENDING_TICK_MS);
}

/** The one act-run paint path: remembers the run for the ticker, threads the
 *  rotating word into the status line, and keeps the ticker alive. */
function paintAct(run: ActRunState | null): void {
  lastActRun = run;
  paintActRun(run, workingWord());
  if (run && (run.phase === 'running' || run.phase === 'stopping')) ensureWorkingTicker();
}

function pushPending(): void {
  clearPending();
  transcript.push({ kind: 'pending', word: PENDING_WORDS[workingWordIndex % PENDING_WORDS.length] });
  paintTranscript();
  ensureWorkingTicker();
}

function clearPending(): void {
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
  // Keep the phase label's rotating word ticking between the 4s polls.
  if (!isTerminalAgentPhase(run.phase) && run.phase !== 'awaiting_approval') ensureWorkingTicker();
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

// ── Brain tab: submitting the prompt — Send always chats ─────────────────────

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
 * The action-intent shortcut — checked before anything else, in EVERY mode.
 * A match skips chatAsk entirely. Auto mode opens immediately; Manual and Plan
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
// than a workflow replay (whose #act-budget field defaults to 40) —
// read_page + one interact + maybe a re-check.
const MANUAL_PAGE_ACTION_MAX_ACTIONS = 6;

/**
 * Chat's "click the X button" shortcut. Reuses the CDP web
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

  const started = await startActRun(instruction, undefined, MANUAL_PAGE_ACTION_MAX_ACTIONS);
  if (!started) {
    showFieldError('prompt-error', 'could not start that — see the run panel below');
    return;
  }
  // Leave the pending bubble alive: it rotates working words ("Fulminating…",
  // "Reading the page…", …) for the WHOLE run; pollActStatus() retires it and
  // lands the closing answer when the run reaches a terminal phase.
  pendingFollowsActRun = true;
  ensureWorkingTicker();
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
    const pageAction = !intent ? detectPageActionIntent(message) : null;
    if (intent) await submitActionIntent(intent);
    else if (pageAction) await submitPageAction(pageAction.instruction);
    else await submitChat(message);
  } finally {
    // A page action hands its pending bubble over to the act run — it is
    // cleared by pollActStatus() on a terminal phase, not here.
    if (!pendingFollowsActRun) clearPending();
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
  paintGraphNodeDetail(); // re-point the detail strip at the fresh node objects
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

/** The selected node's company-sync controls under the canvas. */
function paintGraphNodeDetail(): void {
  const detail = $('graph-node-detail');
  const node = selectedGraphNodeId ? latestGraphNodes.find((n) => n.id === selectedGraphNodeId) : null;
  if (!node) {
    selectedGraphNodeId = null;
    detail.classList.add('hidden');
    return;
  }
  detail.classList.remove('hidden');
  $('graph-node-title').textContent = node.title;
  const priv = $('graph-node-private') as HTMLButtonElement;
  const shared = $('graph-node-shared') as HTMLButtonElement;
  priv.textContent = node.private ? '🔒 Private' : 'Make private';
  priv.title = node.private
    ? 'Private: never synced to the company brain — click to allow syncing again'
    : 'Keep this node on your machine — it will never be synced to the company brain';
  shared.textContent = node.shared ? '★ Shared' : 'Share with company';
  shared.title = node.shared
    ? 'Shown inside the company brain view — click to stop sharing'
    : 'Also show this node inside the company brain view (not just your own)';
  shared.classList.toggle('hidden', node.private === true); // a private node can't be shared
}

async function toggleGraphNodeFlag(flag: 'private' | 'shared'): Promise<void> {
  const node = selectedGraphNodeId ? latestGraphNodes.find((n) => n.id === selectedGraphNodeId) : null;
  if (!node) return;
  const next = !(node[flag] ?? false);
  const msg: PopupToSw =
    flag === 'private'
      ? { type: 'setNodeFlags', id: node.id, private: next, ...(next ? { shared: false } : {}) }
      : { type: 'setNodeFlags', id: node.id, shared: next };
  const reply = await send(msg);
  if (reply.type === 'error') {
    showFieldError('graph-error', reply.message);
    return;
  }
  showFieldError('graph-error', null);
  // Update the local copy now; the next poll's rebuild confirms it.
  node[flag] = next;
  if (flag === 'private' && next) node.shared = false;
  paintGraphNodeDetail();
}

function wireGraphCanvas(): void {
  const canvas = $('graph-canvas');
  $('graph-node-private').addEventListener('click', () => void toggleGraphNodeFlag('private'));
  $('graph-node-shared').addEventListener('click', () => void toggleGraphNodeFlag('shared'));

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
      } else {
        // A press-and-release without movement is a SELECT — show the node's
        // company-sync controls (private / shared) under the canvas.
        selectedGraphNodeId = selectedGraphNodeId === drag.id ? null : drag.id;
        paintGraphNodeDetail();
      }
      return;
    }
    if (!panning) return;
    panning = false;
    panStartBox = null;
    canvas.classList.remove('panning');
  });
}

// ── Settings tab's fallback-key section (BYOK provider) ───────────────────────

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
  $('sp-tab-brain').addEventListener('click', () => selectTab('brain'));
  $('sp-tab-mcp').addEventListener('click', () => selectTab('mcp'));
  $('sp-tab-graph').addEventListener('click', () => selectTab('graph'));
  $('sp-tab-setup').addEventListener('click', () => selectTab('setup'));

  // Settings tab — pairing, capture, allowlist, recorders, record-a-task.
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

  // Settings tab — CRM sync (LinkedIn invites → nff-admin).
  $('crm-sync-save').addEventListener('click', () => void saveCrmSecret());
  $('crm-sync-secret').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void saveCrmSecret();
  });
  $('crm-sync-toggle').addEventListener('click', () => {
    void dispatchSetup({ type: 'setCrmSyncEnabled', enabled: !(latestState?.crmSyncEnabled ?? false) }, 'crm-sync-error')
      .then(() => refreshState());
  });
  $('crm-sync-clear').addEventListener('click', () => {
    void dispatchSetup({ type: 'clearCrmSync' }, 'crm-sync-error').then(() => refreshState());
  });

  // Settings tab — company brain sync (local brain → nff-admin).
  $('brain-sync-save').addEventListener('click', () => void saveBrainSyncToken());
  $('brain-sync-token').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void saveBrainSyncToken();
  });
  $('brain-sync-toggle').addEventListener('click', () => {
    void dispatchSetup({ type: 'setBrainSyncEnabled', enabled: !(latestState?.brainSyncEnabled ?? false) }, 'brain-sync-error')
      .then(() => refreshState());
  });
  $('brain-sync-auto').addEventListener('click', () => {
    void dispatchSetup({ type: 'setBrainSyncAuto', auto: !(latestState?.brainSyncAuto ?? false) }, 'brain-sync-error')
      .then(() => refreshState());
  });
  $('brain-sync-now').addEventListener('click', () => void brainSyncNow());
  $('brain-sync-clear').addEventListener('click', () => {
    void dispatchSetup({ type: 'clearBrainSync' }, 'brain-sync-error').then(() => refreshState());
  });

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

  // Coding agent — project folder + per-run auto-approve.
  $('code-attach').addEventListener('click', () => void attachProject());
  $('code-regrant').addEventListener('click', () => void regrantProject());
  $('code-detach').addEventListener('click', () => void detachProject());
  $('code-auto').addEventListener('change', () => {
    void send({ type: 'codeAutoApprove', enabled: ($('code-auto') as HTMLInputElement).checked });
  });

  $('prompt-send').addEventListener('click', () => void submitPrompt());
  $('prompt-input').addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      void submitPrompt();
    }
  });

  // Settings tab — AI backend switch (#setup-mode). refreshState (not just a
  // Setup repaint) because the choice also moves the header chip and the
  // Plan/Auto gate.
  $('setup-mode-paired').addEventListener('click', () => void send({ type: 'setBrainMode', mode: 'paired' }).then(() => refreshState()));
  $('setup-mode-byok').addEventListener('click', () => void send({ type: 'setBrainMode', mode: 'byok' }).then(() => refreshState()));

  // Settings tab — one-way brain import into the local retrieval store.
  $('setup-brain-import').addEventListener('click', () => {
    const status = $('setup-brain-import-status');
    status.textContent = 'Importing…';
    void send({ type: 'importBrainFromServer' }).then((reply) => {
      status.textContent =
        reply.type === 'brainImported'
          ? `Imported ${reply.imported} note${reply.imported === 1 ? '' : 's'} — ${reply.total} in the local brain.`
          : reply.type === 'error'
            ? reply.message
            : '';
    });
  });

  // Settings tab — direct AI key (#setup-byok)
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
  // shared state (header/Settings incl. its fallback-key section) when it does.
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
  await refreshState(); // may re-gate the initial tab (e.g. hide MCP while unpaired)
  void refreshTrace();
  void refreshCodeStatus();
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
