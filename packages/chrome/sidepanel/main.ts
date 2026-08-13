// The web-agent side panel. Unlike the DevTools panel, a side panel does NOT
// consume the active tab's debugger slot, so the agent can chrome.debugger.attach
// to the very page the user is looking at — the cursor moves in that same tab,
// no new tab, no DevTools conflict.
//
// The panel is a thin client: it resolves the window's ACTIVE tab and reuses the
// existing act messages (actStart/actStop/actGrant/actEnd/getActStatus/
// getWorkflows) that the service worker already handles. The token/provider key
// never enter this realm.

import { paintActRun, renderWorkflows, showError, type WorkflowRow } from './actView.js';
import type { PopupToSw, SwToPopup } from '../src/protocol.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

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

/** The tab the agent should drive: the active tab of this panel's window. */
async function activeTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

function schedulePoll(ms: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void pollStatus(), ms);
}

async function pollStatus(): Promise<void> {
  const reply = await send({ type: 'getActStatus' });
  if (reply.type !== 'actStatus') return;
  paintActRun(reply.run);
  const live =
    reply.run && (reply.run.phase === 'running' || reply.run.phase === 'stopping' || reply.run.phase === 'awaiting_grant');
  if (live) schedulePoll(1000);
}

async function startRun(goal: string, workflowId?: string): Promise<void> {
  showError(null);
  if (!goal) {
    showError('Describe a task first.');
    return;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    showError('Could not find the active tab in this window.');
    return;
  }
  const maxActions = Number(($('act-budget') as HTMLInputElement).value) || undefined;
  const reply = await send({ type: 'actStart', goal, tabId, maxActions, workflowId });
  if (reply.type === 'error') {
    showError(reply.message);
    return;
  }
  if (reply.type === 'actStatus') paintActRun(reply.run);
  schedulePoll(600);
}

async function grant(choice: 'once' | 'always' | 'never'): Promise<void> {
  const reply = await send({ type: 'actGrant', choice });
  if (reply.type === 'actStatus') paintActRun(reply.run);
  schedulePoll(600);
}

async function stopRun(): Promise<void> {
  const reply = await send({ type: 'actStop' });
  if (reply.type === 'actStatus') paintActRun(reply.run);
  schedulePoll(600);
}

async function clearRun(): Promise<void> {
  const reply = await send({ type: 'actEnd' });
  if (reply.type === 'actStatus') paintActRun(reply.run);
}

async function loadWorkflows(): Promise<void> {
  const reply = await send({ type: 'getWorkflows' });
  if (reply.type !== 'workflows') return;
  renderWorkflows(reply.items, (w: WorkflowRow) => {
    const goalEl = $('act-goal') as HTMLTextAreaElement;
    // Seed the goal with the workflow's intent so the user can specialize it.
    if (!goalEl.value.trim()) goalEl.value = w.intent;
    void startRun(goalEl.value.trim() || w.intent, w.id);
  });
}

function wire(): void {
  $('act-start').addEventListener('click', () => void startRun(($('act-goal') as HTMLTextAreaElement).value.trim()));
  $('act-stop').addEventListener('click', () => void stopRun());
  $('act-clear').addEventListener('click', () => void clearRun());
  $('act-grant-once').addEventListener('click', () => void grant('once'));
  $('act-grant-always').addEventListener('click', () => void grant('always'));
  $('act-grant-never').addEventListener('click', () => void grant('never'));

  // The SW pushes storage changes; refresh the run + workflows when it does.
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === 'local') {
      void pollStatus();
      void loadWorkflows();
    }
  });
}

async function boot(): Promise<void> {
  wire();
  await pollStatus();
  await loadWorkflows();
}

void boot();
