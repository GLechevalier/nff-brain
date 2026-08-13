// SW-side web agent orchestration (item 7): adapter registration (mirrors
// recorder.ts step for step) plus the poll loop that drives an approved run.
//
// The loop is alarm-redriven, never a held-open await chain: chrome.alarms
// survive worker death (and browser restart), which is the only thing that
// can span the 1-4 minute gaps between real clickConnect actions. Fast,
// non-paced steps (navigate, readResultCards) chain by direct recursion
// within one invocation, bounded by MAX_POLL_CHAIN so a malformed plan can
// never spin the worker forever on its own.

import { getAgentNextAction, getAgentStatus, reportAgentAction, type ReportAgentActionParams } from './client.js';
import { shouldRunAgentAction } from './agentGate.js';
import { agentAdapterById, AGENT_ADAPTERS } from './agentRegistry.js';
import {
  getAgentActionAllow,
  getAgentAdapters,
  getAgentTab,
  getAllowlist,
  getNavigateHostAllow,
  getPairing,
  setAgentActionAllow,
  setAgentAdapters,
  setAgentTab,
  setAllowlist,
  setNavigateHostAllow,
} from './storage.js';
import { executeNavigate } from './navigateTool.js';
import type { AgentAdapter } from './agentTypes.js';
import type { ContentToAgentReply, NextAction, SwToContent } from './protocol.js';

export const AGENT_POLL_ALARM = 'nb.agentPoll';
const MAX_POLL_CHAIN = 25;
const TAB_LOAD_TIMEOUT_MS = 20_000;

// ── adapter registration (mirrors ensureRecorderScripts/setRecorderEnabled) ──

export async function ensureAgentScripts(): Promise<void> {
  const state = await getAgentAdapters();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map((s) => s.id));

  for (const adapter of AGENT_ADAPTERS) {
    const wantEnabled = state.byId[adapter.id]?.enabled === true;
    const granted = await chrome.permissions.contains({ origins: adapter.originPatterns });
    const scriptId = `agent.${adapter.id}`;
    const want = wantEnabled && granted;

    if (want && !registeredIds.has(scriptId)) {
      await chrome.scripting.registerContentScripts([
        { id: scriptId, js: [adapter.scriptFile], matches: adapter.matches, runAt: 'document_idle', persistAcrossSessions: true },
      ]);
    } else if (!want && registeredIds.has(scriptId)) {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    }
  }
}

/**
 * The popup/agent page has already run chrome.permissions.request (a user
 * gesture is required there). Enable also adds the adapter's hosts to the
 * allowlist, same as the recorder — deliverRecorderClip's audit write goes
 * through the exact same shouldCapture() gate either way.
 */
export async function setAgentAdapterEnabled(id: string, enabled: boolean): Promise<string | null> {
  const adapter = agentAdapterById(id);
  if (!adapter) return 'unknown agent adapter';

  const state = await getAgentAdapters();
  state.byId[id] = { enabled, changedAt: new Date().toISOString() };
  await setAgentAdapters(state);

  if (enabled) {
    const allowlist = await getAllowlist();
    for (const host of adapter.hosts) {
      if (!allowlist.rules.find((r) => r.host === host)) {
        allowlist.rules.push({ host, includeSubdomains: false, addedAt: new Date().toISOString() });
      }
    }
    allowlist.rules.sort((a, b) => a.host.localeCompare(b.host));
    await setAllowlist(allowlist);
  } else {
    try {
      await chrome.permissions.remove({ origins: adapter.originPatterns });
    } catch {
      /* already gone */
    }
    await clearAgentPollAlarm();
  }
  await ensureAgentScripts();
  return null;
}

export async function agentAdapterPublicState(): Promise<
  Array<{ id: string; label: string; hosts: string[]; enabled: boolean; granted: boolean }>
> {
  const state = await getAgentAdapters();
  const out = [];
  for (const adapter of AGENT_ADAPTERS) {
    out.push({
      id: adapter.id,
      label: adapter.label,
      hosts: adapter.hosts,
      enabled: state.byId[adapter.id]?.enabled === true,
      granted: await chrome.permissions.contains({ origins: adapter.originPatterns }),
    });
  }
  return out;
}

// ── Manual-mode chat's action-intent permission prompt ───────────────────────
// A sibling opt-in to the adapter enable/disable above, NOT the same
// question: an adapter can be "never ask again for navigation" without the
// autonomous DOM-automation agent being enabled at all — opening a tab needs
// no chrome.permissions grant, unlike registering the adapter's content script.

export async function agentActionAllowPublicState(): Promise<string[]> {
  const state = await getAgentActionAllow();
  return Object.entries(state.byId)
    .filter(([, v]) => v.allowed)
    .map(([id]) => id);
}

export async function setAgentActionAllowed(adapterId: string, allowed: boolean): Promise<string | null> {
  if (!agentAdapterById(adapterId)) return 'unknown agent adapter';
  const state = await getAgentActionAllow();
  state.byId[adapterId] = { allowed, changedAt: new Date().toISOString() };
  await setAgentActionAllow(state);
  return null;
}

/**
 * Navigates the DevTools-inspected tab to the adapter's site — the
 * permission-prompt's "Yes"/"Always". Stays on the SAME tab (never opens a
 * new one) so the F12 panel driving this stays attached to it; falls back to
 * a new tab only if that tab is gone by the time this runs.
 */
export async function runAdapterNavigate(adapterId: string, tabId: number): Promise<string | null> {
  const adapter = agentAdapterById(adapterId);
  if (!adapter) return 'unknown agent adapter';
  const url = `https://${adapter.hosts[0]}/`;
  try {
    await chrome.tabs.update(tabId, { url });
  } catch {
    await chrome.tabs.create({ url, active: true });
  }
  return null;
}

// ── the same permission prompt, generalized to any site (actionIntent.ts's
// 'kind: host' match) — host-keyed rather than adapter-keyed, since these
// sites have no registered adapter (no DOM automation, just a plain tab). ──

export async function navigateHostAllowPublicState(): Promise<string[]> {
  const state = await getNavigateHostAllow();
  return Object.entries(state.byHost)
    .filter(([, v]) => v.allowed)
    .map(([host]) => host);
}

export async function setNavigateHostAllowed(host: string, allowed: boolean): Promise<void> {
  const state = await getNavigateHostAllow();
  state.byHost[host] = { allowed, changedAt: new Date().toISOString() };
  await setNavigateHostAllow(state);
}

/** Same same-tab-first, new-tab-fallback behavior as runAdapterNavigate — reuses navigateTool's executeNavigate directly. */
export async function runNavigateHost(url: string, tabId: number): Promise<string | null> {
  const result = await executeNavigate({ url }, tabId);
  return result.ok ? null : result.resultText;
}

// ── the poll loop ─────────────────────────────────────────────────────────────

export async function scheduleAgentPoll(delayMs: number): Promise<void> {
  chrome.alarms.create(AGENT_POLL_ALARM, { when: Date.now() + Math.max(delayMs, 0) });
}

export async function clearAgentPollAlarm(): Promise<void> {
  await chrome.alarms.clear(AGENT_POLL_ALARM);
}

function waitForTabComplete(tabId: number, timeoutMs = TAB_LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs); // never hang the loop on a slow/broken load
  });
}

/** Reuses the SW's own previously-opened tab for this adapter; opens one otherwise. */
async function ensureAgentTab(adapter: AgentAdapter): Promise<number> {
  const stored = await getAgentTab();
  if (stored && stored.adapterId === adapter.id) {
    try {
      const tab = await chrome.tabs.get(stored.tabId);
      if (tab?.id !== undefined) return tab.id;
    } catch {
      /* tab was closed — fall through and open a new one */
    }
  }
  const created = await chrome.tabs.create({ url: `https://${adapter.hosts[0]}/`, active: false });
  if (created.id === undefined) throw new Error('could not open a tab for the web agent');
  await setAgentTab({ tabId: created.id, adapterId: adapter.id });
  await waitForTabComplete(created.id);
  return created.id;
}

async function sendToContent(tabId: number, msg: SwToContent): Promise<ContentToAgentReply> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, msg)) as ContentToAgentReply | undefined;
    return reply ?? { ok: false, error: 'content script did not respond' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** v1 is LinkedIn-only — the plan carries no site id, so this is the one place that assumption lives. */
async function currentAdapter(): Promise<AgentAdapter | null> {
  return agentAdapterById('linkedin') ?? null;
}

async function performAgentAction(action: NextAction): Promise<ReportAgentActionParams['result']> {
  const adapter = await currentAdapter();
  if (!adapter) return { ok: false, summary: 'no agent adapter registered' };

  const adapters = await getAgentAdapters();
  const gateUrl = `https://${adapter.hosts[0]}/`;
  const allowed = shouldRunAgentAction(gateUrl, {
    agentEnabled: adapters.byId[adapter.id]?.enabled === true,
    hosts: adapter.hosts,
  });
  if (!allowed) return { ok: false, summary: 'the LinkedIn agent is not enabled' };

  if (action.verb === 'navigate') {
    const tabId = await ensureAgentTab(adapter);
    const url = action.args.url;
    if (!url) return { ok: false, summary: 'navigate action carried no url' };
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    return { ok: true, summary: 'navigated' };
  }

  const tabId = await ensureAgentTab(adapter);

  if (action.verb === 'readResultCards') {
    const reply = await sendToContent(tabId, { type: 'agentReadCards' });
    if (!reply.ok) return { ok: false, summary: reply.error };
    if (reply.verb !== 'readResultCards') return { ok: false, summary: 'unexpected content-script reply' };
    return { ok: true, summary: `read ${reply.cards.length} card(s)`, cards: reply.cards };
  }

  // clickConnect
  const cardIndex = Number(action.args.cardIndex);
  if (!Number.isInteger(cardIndex)) return { ok: false, summary: 'clickConnect action carried no cardIndex' };
  const reply = await sendToContent(tabId, { type: 'agentClickConnect', cardIndex });
  if (!reply.ok) return { ok: false, summary: reply.error };
  if (reply.verb !== 'clickConnect') return { ok: false, summary: 'unexpected content-script reply' };
  return { ok: true, summary: `connected with ${reply.fields.name}`, fields: reply.fields };
}

/**
 * One poll cycle: fetch status, fetch the next action (if any), perform it,
 * report the result, then either chain immediately (fast, unpaced steps) or
 * re-arm the alarm (a clickConnect just bumped the server's pacing gate).
 */
export async function pollAgent(depth = 0): Promise<void> {
  await clearAgentPollAlarm(); // this cycle supersedes any alarm that fired it

  const pairing = await getPairing();
  if (!pairing) return;

  let run;
  try {
    run = (await getAgentStatus(pairing.port, pairing.token)).run;
  } catch {
    await scheduleAgentPoll(60_000);
    return;
  }
  if (!run || run.phase !== 'running') return; // nothing to do — a fresh approve re-arms this

  let next;
  try {
    next = await getAgentNextAction(pairing.port, pairing.token);
  } catch {
    await scheduleAgentPoll(60_000);
    return;
  }

  if (!next.action) {
    const delayMs = Math.max(60_000, (next.nextAllowedAtMs ?? Date.now() + 60_000) - Date.now());
    await scheduleAgentPoll(delayMs);
    return;
  }

  const result = await performAgentAction(next.action);

  let reported;
  try {
    reported = await reportAgentAction(pairing.port, pairing.token, {
      runId: run.id,
      stepId: next.action.stepId,
      verb: next.action.verb,
      args: next.action.args,
      result,
    });
  } catch {
    // The real-world action (if it was a clickConnect) already happened —
    // only this cycle's bookkeeping is lost. Retry the poll shortly; the
    // server's own state (cursor/pendingConnects) is unaffected either way.
    await scheduleAgentPoll(60_000);
    return;
  }

  if (!reported.run || reported.run.phase !== 'running') return; // done/stopped/error — stop polling

  if (next.action.verb === 'clickConnect') {
    const delayMs = reported.run.nextAllowedAtMs - Date.now();
    if (delayMs > 0) {
      await scheduleAgentPoll(delayMs);
      return;
    }
  }

  if (depth >= MAX_POLL_CHAIN) {
    await scheduleAgentPoll(60_000); // safety valve — never spin one invocation forever
    return;
  }
  await pollAgent(depth + 1);
}
