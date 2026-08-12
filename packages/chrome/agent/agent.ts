// Web agent page entry: wires listeners, owns no logic. Same split as
// popup/main.ts — this file dispatches messages and calls paint.ts; the
// service worker (agentRunner.ts + the agent* cases in sw.ts) owns every
// real decision, and the run itself lives server-side.

import { agentAdapterById } from '../src/agentRegistry.js';
import type { AgentPageToSw, McpToolDef, SwToAgentPage, WebAgentListTarget, WebAgentRun } from '../src/protocol.js';
import { paintAdapter, paintMcpServers, paintMcpTools, paintPanels, paintPlan, paintRun, panelModeFor, showFieldError } from './paint.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const STATUS_POLL_MS = 4000;

let latestRun: WebAgentRun | null = null;
const mcpToolsByServer = new Map<string, McpToolDef[]>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function send(msg: AgentPageToSw): Promise<SwToAgentPage> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToAgentPage) => {
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

function isTerminal(phase: WebAgentRun['phase']): boolean {
  return phase === 'stopped' || phase === 'done' || phase === 'error';
}

function schedulePoll(delayMs: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void pollStatus(), delayMs);
}

function applyRun(run: WebAgentRun | null): void {
  latestRun = run;
  const mode = panelModeFor(run);
  paintPanels(mode);
  if (mode === 'plan' && run) paintPlan(run);
  if (mode === 'run' && run) paintRun(run);
}

async function pollStatus(): Promise<void> {
  const reply = await send({ type: 'getAgentStatus' });
  if (reply.type === 'agentStatus') applyRun(reply.run);
  if (latestRun && !isTerminal(latestRun.phase)) schedulePoll(STATUS_POLL_MS);
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

async function loadMcpServers(): Promise<void> {
  const reply = await send({ type: 'getMcpServers' });
  if (reply.type !== 'mcpServers') return;
  paintMcpServers(reply.servers, '');
  paintMcpTools([], null);
}

async function loadMcpTools(serverId: string): Promise<void> {
  if (!serverId) {
    paintMcpTools([], null);
    return;
  }
  if (!mcpToolsByServer.has(serverId)) {
    const reply = await send({ type: 'getMcpTools', server: serverId });
    if (reply.type !== 'mcpTools') return;
    mcpToolsByServer.set(serverId, reply.tools);
  }
  paintMcpTools(mcpToolsByServer.get(serverId) ?? [], null);
}

function selectedListTarget(): WebAgentListTarget | null {
  const serverId = ($('list-server') as HTMLSelectElement).value;
  if (!serverId) return null;
  const toolName = ($('list-tool') as HTMLSelectElement).value;
  const toolDef = mcpToolsByServer.get(serverId)?.find((t) => t.name === toolName);
  if (!toolDef) return null;
  return { server: serverId, tool: toolName, toolDef };
}

async function submitGoal(): Promise<void> {
  const goal = ($('goal-input') as HTMLTextAreaElement).value.trim();
  if (!goal) {
    showFieldError('goal-error', 'type a goal first');
    return;
  }
  const maxActions = Number(($('max-actions') as HTMLInputElement).value) || 5;
  const listTarget = selectedListTarget();

  const reply = await send({ type: 'agentSubmitGoal', goal, maxActions, listTarget });
  if (reply.type === 'error') {
    showFieldError('goal-error', reply.message);
    return;
  }
  showFieldError('goal-error', null);
  if (reply.type === 'agentStatus') applyRun(reply.run);
  schedulePoll(1000);
}

async function approvePlan(): Promise<void> {
  if (!latestRun) return;
  const reply = await send({ type: 'agentApprovePlan', runId: latestRun.id });
  if (reply.type === 'agentStatus') applyRun(reply.run);
  schedulePoll(1000);
}

async function rejectPlan(): Promise<void> {
  if (!latestRun) return;
  const reply = await send({ type: 'agentRejectPlan', runId: latestRun.id });
  if (reply.type === 'agentStatus') applyRun(reply.run);
}

async function stopRun(): Promise<void> {
  if (!latestRun) return;
  const reply = await send({ type: 'agentStop', runId: latestRun.id });
  if (reply.type === 'agentStatus') applyRun(reply.run);
}

function wire(): void {
  $('adapter-toggle').addEventListener('click', () => void toggleAdapter());
  $('goal-submit').addEventListener('click', () => void submitGoal());
  $('list-server').addEventListener('change', (e) => void loadMcpTools((e.target as HTMLSelectElement).value));
  $('plan-approve').addEventListener('click', () => void approvePlan());
  $('plan-reject').addEventListener('click', () => void rejectPlan());
  $('run-stop').addEventListener('click', () => void stopRun());
}

async function boot(): Promise<void> {
  wire();
  await refreshAdapterState();
  await loadMcpServers();
  await pollStatus();
}

void boot();
