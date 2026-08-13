// MV3 service worker ENTRY POINT. Listener registration only.
//
// ── the MV3 rule this file exists to enforce ────────────────────────────────
// Chrome tears this worker down after ~30s idle and re-creates it cold to
// deliver the next event. Two consequences, both of which have bitten every
// MV3 extension ever written:
//
//  1. EVERY listener must be registered SYNCHRONOUSLY at top level, before any
//     await. A listener registered inside a .then() is not registered yet when
//     Chrome cold-starts the worker to deliver that very event, and the event
//     is silently dropped.
//
//  2. NO module-level state. Concretely, the four failure modes:
//       let token          → works 30s, then the probe 401s; the user re-pairs,
//                            which appears to fix it — for another 30s.
//       let captureEnabled → SECURITY-RELEVANT: after a restart the flag reverts
//                            to its initializer and pause stops holding.
//       let rules = []     → reverts to deny-all; capture silently stops.
//       any storage cache  → the popup and this worker are SEPARATE JS REALMS,
//                            so a cache here never sees a popup write.
//     The single exception is connection.ts's in-flight probe promise, which is
//     documented there and is harmless to lose.

import { createMenus, onMenuClicked } from './capture.js';
import { paintBadge } from './badge.js';
import {
  approveAgentPlan,
  askChat,
  getAgentStatus,
  getGraph,
  getMcpServers,
  getMcpTools,
  getNodes,
  moveGraphNode,
  rejectAgentPlan,
  removeMcpServer,
  retract,
  searchBrain,
  setMcpServerEnabled as setMcpServerEnabledOnServer,
  stopAgentRun,
  submitAgentGoal,
} from './client.js';
import { HEALTH_ALARM, currentPhase, ensureAlarm, pairWithServer, probe, unpair } from './connection.js';
import { clearActivity, removableNodeCount } from './activity.js';
import { parseRuleInput, ruleLabel } from './gate.js';
import { derivePhase } from './health.js';
import { ensureRecorderScripts, onRecorderEvent, recorderPublicState, setRecorderEnabled } from './recorder.js';
import {
  AGENT_POLL_ALARM,
  agentActionAllowPublicState,
  agentAdapterPublicState,
  clearAgentPollAlarm,
  ensureAgentScripts,
  navigateHostAllowPublicState,
  pollAgent,
  runAdapterNavigate,
  runNavigateHost,
  setAgentActionAllowed,
  setAgentAdapterEnabled,
  setNavigateHostAllowed,
} from './agentRunner.js';
import {
  getActivity,
  getAllowlist,
  getBrain,
  getCapture,
  getHealth,
  getPairing,
  getProviderSettings,
  seedDefaults,
  setAllowlist,
  setCapture,
  setProviderSettings,
} from './storage.js';
import { testProviderKey } from './providerClient.js';
import { handleStandaloneMessage } from './standalone.js';
import { DRAIN_ALARM, drainStandaloneClips, ensureDrainAlarm } from './standaloneDrain.js';
import { PROVIDERS } from '@nff-brain/core/provider';
import type { PopupToSw, PublicState, SwToPopup } from './protocol.js';

async function publicState(): Promise<PublicState> {
  const [pairing, health, capture, allowlist, activity, provider, brain] = await Promise.all([
    getPairing(),
    getHealth(),
    getCapture(),
    getAllowlist(),
    getActivity(),
    getProviderSettings(),
    getBrain(),
  ]);
  const { nextProbeAtMs, ...rest } = health;
  void nextProbeAtMs; // internal scheduling; the popup has no use for it
  const localNodes = brain?.nodes.length ?? 0;
  return {
    // A stored pairing always wins — standalone only exists while unpaired.
    phase:
      pairing !== null
        ? derivePhase(health, true, Date.now())
        : provider !== null
          ? 'standalone'
          : 'unpaired',
    port: pairing?.port ?? null,
    health: rest,
    capture,
    rules: allowlist.rules,
    activityCount: activity.length,
    removableNodeCount: removableNodeCount(activity),
    recorders: await recorderPublicState(),
    agentAdapters: await agentAdapterPublicState(),
    agentActionAllow: await agentActionAllowPublicState(),
    navigateHostAllow: await navigateHostAllowPublicState(),
    providerConfigured: provider !== null,
    provider: provider?.provider ?? null,
    providerModels: provider?.models ?? null,
    providerLastTest: provider?.lastTest ?? null,
    standaloneNodes: pairing === null ? localNodes : null,
    // While paired, any surviving local brain is a migration waiting to finish.
    migrationPending: pairing !== null && localNodes > 0 ? localNodes : null,
  };
}

async function handleMessage(msg: PopupToSw): Promise<SwToPopup> {
  // STANDALONE INTERCEPTOR — before the switch, so every paired case below
  // stays byte-identical. Only when no pairing is stored: messages with a
  // local-brain meaning are answered from nb.brain; 'handled' means the work
  // is done and the default state reply should follow; null falls through to
  // the existing not-paired guards.
  if (!(await getPairing())) {
    const local = await handleStandaloneMessage(msg);
    if (local === 'handled') return { type: 'state', state: await publicState() };
    if (local) return local;
  }
  switch (msg.type) {
    case 'getState':
      break;

    case 'probeNow':
      await probe({ force: true });
      break;

    case 'pair': {
      const result = await pairWithServer(msg.port, msg.code);
      if (!result.ok) return { type: 'error', message: result.error ?? 'pairing failed' };
      break;
    }

    case 'unpair':
      await unpair();
      break;

    case 'setCaptureEnabled': {
      const capture = await setCapture(msg.enabled);
      await paintBadge(await currentPhase(), capture.enabled);
      break;
    }

    case 'addRule': {
      const parsed = parseRuleInput(msg.input);
      if ('error' in parsed) return { type: 'error', message: parsed.error };
      const allowlist = await getAllowlist();
      const existing = allowlist.rules.find((r) => r.host === parsed.rule.host);
      if (existing) {
        // Re-adding with a wildcard widens an exact rule rather than duplicating.
        existing.includeSubdomains ||= parsed.rule.includeSubdomains;
      } else {
        allowlist.rules.push(parsed.rule);
      }
      allowlist.rules.sort((a, b) => a.host.localeCompare(b.host));
      await setAllowlist(allowlist);
      void ruleLabel;
      break;
    }

    case 'removeRule': {
      const allowlist = await getAllowlist();
      allowlist.rules = allowlist.rules.filter((r) => r.host !== msg.host);
      await setAllowlist(allowlist);
      break;
    }

    // DevTools panel data — early returns with a data reply instead of the
    // state snapshot. Routed through this worker so the panel never holds the
    // bearer token.
    case 'getNodes': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      return { type: 'nodes', data: await getNodes(pairing.port, pairing.token, msg.limit) };
    }

    case 'getGraph': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { nodes: graphNodes, edges } = await getGraph(pairing.port, pairing.token);
      return { type: 'graph', nodes: graphNodes, edges };
    }

    case 'moveGraphNode': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { moved } = await moveGraphNode(pairing.port, pairing.token, msg.id, msg.x, msg.y);
      return { type: 'layout', moved };
    }

    case 'searchBrain': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      return { type: 'search', data: await searchBrain(pairing.port, pairing.token, msg.q, msg.limit) };
    }

    case 'setRecorderEnabled': {
      const error = await setRecorderEnabled(msg.id, msg.enabled);
      if (error) return { type: 'error', message: error };
      break;
    }

    // Web agent (item 7). Every mutating message replies with the fresh run
    // (or null), same "always hand back the thing that changed" shape as the
    // recorder/state pattern above — the agent page never needs a second
    // round trip just to see what it just did.
    case 'setAgentAdapterEnabled': {
      const error = await setAgentAdapterEnabled(msg.id, msg.enabled);
      if (error) return { type: 'error', message: error };
      break;
    }

    // Manual-mode chat's action-intent permission prompt — independent of the
    // adapter enable/disable above (see agentRunner.ts's runAdapterNavigate
    // comment). Both fall through to the default state reply, which is where
    // the fresh agentActionAllow list rides back to the panel.
    case 'setAgentActionAllowed': {
      const error = await setAgentActionAllowed(msg.adapterId, msg.allowed);
      if (error) return { type: 'error', message: error };
      break;
    }

    case 'runAdapterNavigate': {
      const error = await runAdapterNavigate(msg.adapterId, msg.tabId);
      if (error) return { type: 'error', message: error };
      break;
    }

    case 'setNavigateHostAllowed':
      await setNavigateHostAllowed(msg.host, msg.allowed);
      break;

    case 'runNavigateHost': {
      const error = await runNavigateHost(msg.url, msg.tabId);
      if (error) return { type: 'error', message: error };
      break;
    }

    case 'agentSubmitGoal': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      try {
        await submitAgentGoal(pairing.port, pairing.token, {
          goal: msg.goal,
          maxActions: msg.maxActions,
          listTarget: msg.listTarget,
          autoApprove: msg.autoApprove,
        });
      } catch (err) {
        return { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run };
    }

    case 'agentApprovePlan': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const status = await approveAgentPlan(pairing.port, pairing.token, msg.runId);
      // Kicks the poll loop off immediately rather than waiting for an alarm
      // — approving a plan is the strongest possible signal to start now.
      void pollAgent();
      return { type: 'agentStatus', run: status.run };
    }

    case 'agentRejectPlan': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const status = await rejectAgentPlan(pairing.port, pairing.token, msg.runId);
      return { type: 'agentStatus', run: status.run };
    }

    case 'agentStop': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      // Clear the alarm HERE too (belt-and-braces) — don't wait for a poll
      // that may not come for up to 4 minutes to notice the run stopped.
      await clearAgentPollAlarm();
      await stopAgentRun(pairing.port, pairing.token, msg.runId);
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run };
    }

    case 'getAgentStatus': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'agentStatus', run: null };
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run };
    }

    case 'getMcpServers': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { servers } = await getMcpServers(pairing.port, pairing.token);
      return { type: 'mcpServers', servers };
    }

    case 'getMcpTools': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { tools } = await getMcpTools(pairing.port, pairing.token, msg.server);
      return { type: 'mcpTools', tools };
    }

    // MCP tab mutations — enable/disable/remove an ALREADY-registered server.
    // Registering a new one stays CLI-only (nff-brain mcp add); these two
    // never touch url/headers.
    case 'setMcpServerEnabled': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { servers } = await setMcpServerEnabledOnServer(pairing.port, pairing.token, msg.id, msg.enabled);
      return { type: 'mcpServers', servers };
    }

    case 'removeMcpServer': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      const { servers } = await removeMcpServer(pairing.port, pairing.token, msg.id);
      return { type: 'mcpServers', servers };
    }

    // Manual-mode chat (item: Brain tab redesign) — the one route that costs
    // a token per message, and the one call site that needs a longer timeout
    // than every other route (see CHAT_TIMEOUT_MS).
    case 'chatAsk': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the extension popup' };
      try {
        const { answer, sources } = await askChat(pairing.port, pairing.token, msg.message, msg.history);
        return { type: 'chatAnswer', answer, sources };
      } catch (err) {
        return { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    // BYOK provider settings (options page). setProvider is the ONE inbound
    // path for the key; no reply ever carries it back out.
    case 'setProvider': {
      const adapter = PROVIDERS[msg.provider];
      if (!adapter) return { type: 'error', message: 'that provider is not available yet' };
      const key = msg.apiKey.trim();
      if (!key) return { type: 'error', message: 'an API key is required' };
      const existing = await getProviderSettings();
      await setProviderSettings({
        provider: msg.provider,
        apiKey: key,
        // Keep the user's model picks across a key rotation; defaults otherwise.
        models: existing?.provider === msg.provider ? existing.models : { ...adapter.defaultModels },
        addedAt: new Date().toISOString(),
        lastTest: null,
      });
      await paintBadge(await currentPhase(), (await getCapture()).enabled);
      break;
    }

    case 'setProviderModels': {
      const existing = await getProviderSettings();
      if (!existing) return { type: 'error', message: 'save an API key first' };
      const background = msg.models.background.trim();
      const chat = msg.models.chat.trim();
      if (!background || !chat) return { type: 'error', message: 'both model fields are required' };
      await setProviderSettings({ ...existing, models: { background, chat } });
      break;
    }

    case 'clearProvider':
      await setProviderSettings(null);
      await paintBadge(await currentPhase(), (await getCapture()).enabled);
      break;

    case 'testProvider':
      return { type: 'providerTest', result: await testProviderKey() };

    case 'clearActivity': {
      if (msg.alsoRemoveNodes) {
        const nodeIds = [...new Set((await getActivity()).flatMap((r) => r.nodeIds))];
        if (nodeIds.length > 0) {
          const pairing = await getPairing();
          if (!pairing) return { type: 'error', message: 'not paired — nothing was deleted' };
          try {
            // The server enforces the real gates (origin 'clip', own-client
            // attribution); `removed` is what actually went.
            await retract(pairing.port, pairing.token, nodeIds);
          } catch {
            // Do NOT clear on failure: wiping the buffer now would orphan the
            // clip→node mapping forever and the nodes would become undeletable.
            return { type: 'error', message: 'could not reach the brain — nothing was deleted' };
          }
        }
      }
      await clearActivity();
      break;
    }
  }
  return { type: 'state', state: await publicState() };
}

async function onInstalled(): Promise<void> {
  // MERGE, never overwrite: onInstalled also fires with reason 'update' on every
  // extension update, and storage.set(DEFAULTS) there would re-enable capture
  // and wipe the allowlist behind the user's back.
  await seedDefaults();
  createMenus();
  // Registered content scripts are cleared on every extension update —
  // reconcile them against stored recorder AND agent-adapter state here,
  // idempotently.
  await ensureRecorderScripts();
  await ensureAgentScripts();
  await ensureAlarm();
  await paintBadge(await currentPhase(), (await getCapture()).enabled);
}

async function onStartup(): Promise<void> {
  // Deliberately does NOT write nb.capture — pause must survive a restart.
  await ensureAlarm();
  await probe();
  // chrome.alarms survive a browser restart, so a mid-run nb.agentPoll alarm
  // should still fire on its own — this is just insurance in case it didn't.
  void pollAgent();
  // Same insurance for the standalone drain: a queue left over from before the
  // restart re-arms its tick (the handler no-ops unless a drain is actually due).
  void ensureDrainAlarm();
}

async function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name === HEALTH_ALARM) {
    await probe();
    return;
  }
  if (alarm.name === AGENT_POLL_ALARM) {
    await pollAgent();
    return;
  }
  if (alarm.name === DRAIN_ALARM) {
    await drainStandaloneClips();
  }
}

// ── registration, synchronous, top level ────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => void onInstalled());
chrome.runtime.onStartup.addListener(() => void onStartup());
chrome.alarms.onAlarm.addListener((alarm) => void onAlarm(alarm));
chrome.contextMenus.onClicked.addListener((info, tab) => void onMenuClicked(info, tab));
chrome.permissions.onAdded.addListener(() => void probe({ force: true }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Recorder events come from content scripts, are fire-and-forget, and must
  // never flow into the popup message switch (their sender matters).
  if ((msg as { type?: string })?.type === 'recorderEvent') {
    void onRecorderEvent(msg, sender);
    sendResponse({ type: 'state' }); // ack; content scripts ignore replies
    return true;
  }
  // NOT `async (msg) => …`: Chrome ignores a returned Promise (Firefox does
  // not). The literal `return true` below is what keeps the message port open
  // until sendResponse fires.
  void handleMessage(msg as PopupToSw).then(sendResponse, (err: unknown) =>
    sendResponse({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});
