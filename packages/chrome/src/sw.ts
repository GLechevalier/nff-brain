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
//       any storage cache  → the side panel and this worker are SEPARATE JS
//                            REALMS, so a cache here never sees a panel write.
//     The single exception is connection.ts's in-flight probe promise, which is
//     documented there and is harmless to lose.

import { createMenus, onMenuClicked } from './capture.js';
import { onCrmMenuClicked } from './crmMenu.js';
import { paintBadge } from './badge.js';
import {
  approveAgentPlan,
  askChat,
  getAgentStatus,
  getGraph,
  getMcpServers,
  getMcpTools,
  getNodes,
  getExport,
  getWorkflows as getWorkflowsFromServer,
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
import { clearActivity, logVisit, removableNodeCount } from './activity.js';
import { capturePageVisit } from './pageVisitCapture.js';
import { parseRuleInput, ruleLabel } from './gate.js';
import { derivePhase } from './health.js';
import { ensureRecorderScripts, onLinkedinInviteRequest, onLinkedinNet, onRecorderEvent, recorderPublicState, setRecorderEnabled } from './recorder.js';
import {
  AGENT_POLL_ALARM,
  agentActionAllowPublicState,
  agentAdapterPublicState,
  clearAgentPollAlarm,
  ensureAgentScripts,
  navigateHostAllowPublicState,
  pollAgent,
  runAdapterNavigate,
  runNavigateHistory,
  runNavigateHost,
  setAgentActionAllowed,
  setAgentAdapterEnabled,
  setNavigateHostAllowed,
} from './agentRunner.js';
import {
  getActivity,
  getAllowlist,
  getBrain,
  getBrainModePref,
  getCapture,
  getBrainSync,
  getCrmSync,
  getHealth,
  getPairing,
  getProviderSettings,
  seedDefaults,
  setAllowlist,
  setBrainModePref,
  setCapture,
  setBrainSync,
  setCrmSync,
  setProviderSettings,
} from './storage.js';
import { ACTIVITY_PREVIEW, CRM_ORIGIN_PATTERN } from './protocol.js';
import { deriveBrainMode, resolveBrainMode } from './mode.js';
import { byokChatAsk } from './byokChat.js';
import { listLocalWorkflows, syncWorkflowsFromServer } from './workflowStore.js';
import { distillPendingTrace } from './standaloneTraceDistill.js';
import { DRAIN_ALARM, drainStandaloneClips, ensureDrainAlarm } from './standaloneDrain.js';
import { mergeImportedBrain, mutateLocalBrain, readLocalBrain } from './brainStore.js';
import { setNodeFlags as setNodeFlagsOnServer } from './client.js';
import { testProviderKey } from './providerClient.js';
import { answerPendingGrant, endActionRun, setCodeAutoApprove, startActionRun, stopActionRun } from './actRun.js';
import { clearProjectHandle, queryProjectPermission } from './fsHandles.js';
import { getCodeProject, getLogVisits, setCodeProject, setLogVisits } from './storage.js';
import { attentionHide, cursorHide } from './actEngine.js';
import { cancelTraceRecording, onTraceEvent, startTraceRecording, stopTraceRecording } from './traceCapture.js';
import { dumpNetCapture, startNetCapture } from './netCapture.js';
import { distillPairedTrace } from './pairedTraceDistill.js';
import { syncBrainToCompany, testBrainSync } from './companySync.js';
import { testCrmSync } from './crmSync.js';
import { getActHostAllow, getActRun, getTraceActive, getTracePending, setActHostAllow } from './storage.js';
import { mutateActRun } from './actStore.js';
import { PROVIDERS } from '@nff-brain/core/provider';
import type { PopupToSw, PublicState, SwToPopup } from './protocol.js';

async function publicState(): Promise<PublicState> {
  const [pairing, health, capture, allowlist, activity, provider, legacyBrain, brainModePref, crmSync, brainSync, logVisits] = await Promise.all([
    getPairing(),
    getHealth(),
    getCapture(),
    getAllowlist(),
    getActivity(),
    getProviderSettings(),
    // The brain graph is always server-side now — this ONE read is the sole
    // surviving exception, purely to detect a pre-upgrade user's leftover
    // local brain so migrateIfNeeded() (migrate.ts) has something to finish.
    getBrain(),
    getBrainModePref(),
    getCrmSync(),
    getBrainSync(),
    getLogVisits(),
  ]);
  const { nextProbeAtMs, ...rest } = health;
  void nextProbeAtMs; // internal scheduling; the UI has no use for it
  return {
    phase: pairing !== null ? derivePhase(health, true, Date.now()) : 'unpaired',
    port: pairing?.port ?? null,
    health: rest,
    capture,
    logVisits,
    rules: allowlist.rules,
    activityCount: activity.length,
    activity: activity.slice(0, ACTIVITY_PREVIEW).map(({ id, at, title, url, delivery }) => ({ id, at, title, url, delivery })),
    removableNodeCount: removableNodeCount(activity),
    recorders: await recorderPublicState(),
    agentAdapters: await agentAdapterPublicState(),
    agentActionAllow: await agentActionAllowPublicState(),
    navigateHostAllow: await navigateHostAllowPublicState(),
    providerConfigured: provider !== null,
    provider: provider?.provider ?? null,
    crmSyncConfigured: crmSync !== null,
    crmSyncEnabled: crmSync?.enabled === true,
    brainSyncConfigured: brainSync !== null,
    brainSyncEnabled: brainSync?.enabled === true,
    brainSyncAuto: brainSync?.auto === true,
    brainSyncLastAt: brainSync?.lastSyncedAt ?? null,
    providerModels: provider?.models ?? null,
    providerLastTest: provider?.lastTest ?? null,
    brainMode: deriveBrainMode(brainModePref, pairing !== null, provider !== null),
    brainModePref,
    // Non-null whether paired or not — the blocked-state UI shows the count
    // ("N notes saved from before — pair to keep them") before the user ever
    // pairs; migrateIfNeeded() clears it once the import lands.
    migrationPending: (legacyBrain?.nodes.length ?? 0) > 0 ? legacyBrain!.nodes.length : null,
  };
}

async function handleMessage(msg: PopupToSw): Promise<SwToPopup> {
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

    case 'setLogVisits':
      await setLogVisits(msg.enabled);
      break;

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
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      return { type: 'nodes', data: await getNodes(pairing.port, pairing.token, msg.limit) };
    }

    case 'getGraph': {
      const pairing = await getPairing();
      if (pairing) {
        const { nodes: graphNodes, edges } = await getGraph(pairing.port, pairing.token);
        return { type: 'graph', nodes: graphNodes, edges };
      }
      // Unpaired: the local BYOK brain — so its nodes stay browsable and the
      // company-sync flags stay toggleable without a server.
      const local = await readLocalBrain();
      if (local.nodes.length === 0) return { type: 'error', message: 'not paired and no local brain yet' };
      return {
        type: 'graph',
        nodes: local.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          category: n.category,
          origin: n.origin,
          x: n.x,
          y: n.y,
          size: n.size,
          color: n.color,
          private: n.private === true,
          shared: n.shared === true,
        })),
        edges: local.edges.map((e) => ({ from: e.from, to: e.to, strength: e.strength })),
      };
    }

    case 'moveGraphNode': {
      const pairing = await getPairing();
      if (pairing) {
        const { moved } = await moveGraphNode(pairing.port, pairing.token, msg.id, msg.x, msg.y);
        return { type: 'layout', moved };
      }
      const moved = await mutateLocalBrain((brain) => {
        const node = brain.nodes.find((n) => n.id === msg.id);
        if (!node) return false;
        node.x = msg.x;
        node.y = msg.y;
        node.laidOut = true;
        return true;
      });
      return { type: 'layout', moved };
    }

    case 'searchBrain': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
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

    case 'runNavigateHistory': {
      const error = await runNavigateHistory(msg.direction, msg.tabId);
      if (error) return { type: 'error', message: error };
      break;
    }

    case 'agentSubmitGoal': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
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
      // The submit is the only signal an auto-approved run ever sends (there
      // is no approve click to kick the loop) — arm it now; pollAgent re-arms
      // itself through the planning phase until the run starts or dies.
      void pollAgent();
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run, lastRun: status.lastRun ?? null };
    }

    case 'agentApprovePlan': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const status = await approveAgentPlan(pairing.port, pairing.token, msg.runId);
      // Kicks the poll loop off immediately rather than waiting for an alarm
      // — approving a plan is the strongest possible signal to start now.
      void pollAgent();
      return { type: 'agentStatus', run: status.run };
    }

    case 'agentRejectPlan': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const status = await rejectAgentPlan(pairing.port, pairing.token, msg.runId);
      return { type: 'agentStatus', run: status.run };
    }

    case 'agentStop': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      // Clear the alarm HERE too (belt-and-braces) — don't wait for a poll
      // that may not come for up to 4 minutes to notice the run stopped.
      await clearAgentPollAlarm();
      await stopAgentRun(pairing.port, pairing.token, msg.runId);
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run, lastRun: status.lastRun ?? null };
    }

    case 'getAgentStatus': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'agentStatus', run: null };
      const status = await getAgentStatus(pairing.port, pairing.token);
      return { type: 'agentStatus', run: status.run, lastRun: status.lastRun ?? null };
    }

    case 'getMcpServers': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const { servers } = await getMcpServers(pairing.port, pairing.token);
      return { type: 'mcpServers', servers };
    }

    case 'getMcpTools': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const { tools } = await getMcpTools(pairing.port, pairing.token, msg.server);
      return { type: 'mcpTools', tools };
    }

    // MCP tab mutations — enable/disable/remove an ALREADY-registered server.
    // Registering a new one stays CLI-only (nff-brain mcp add); these two
    // never touch url/headers.
    case 'setMcpServerEnabled': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const { servers } = await setMcpServerEnabledOnServer(pairing.port, pairing.token, msg.id, msg.enabled);
      return { type: 'mcpServers', servers };
    }

    case 'removeMcpServer': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'not paired — pair from the Settings tab' };
      const { servers } = await removeMcpServer(pairing.port, pairing.token, msg.id);
      return { type: 'mcpServers', servers };
    }

    // Manual-mode chat (item: Brain tab redesign) — the one route that costs
    // a token per message, and the one call site that needs a longer timeout
    // than every other route (see CHAT_TIMEOUT_MS).
    case 'chatAsk': {
      // Mode-routed like the act loop (mode.ts): paired chat answers with the
      // server-side brain via /v1/chat, byte-identical to before; BYOK chat
      // answers over the direct provider API with the navigate tool wired in.
      const chatMode = await resolveBrainMode();
      if (chatMode === 'byok') return byokChatAsk(msg.message, msg.history, msg.tabId);
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'pair from the Settings tab, or add an API key, to chat' };
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

    // CRM sync (Settings). setCrmSyncSecret is the ONE inbound path for the
    // ingest secret; no reply ever carries it back out.
    case 'setCrmSyncSecret': {
      const secret = msg.secret.trim();
      if (!secret) return { type: 'error', message: 'an ingest secret is required' };
      await setCrmSync({ enabled: true, secret, addedAt: new Date().toISOString() });
      break;
    }

    case 'setCrmSyncEnabled': {
      const existing = await getCrmSync();
      if (!existing) return { type: 'error', message: 'save the ingest secret first' };
      await setCrmSync({ ...existing, enabled: msg.enabled });
      break;
    }

    case 'clearCrmSync':
      await setCrmSync(null);
      // Best-effort: the grant is useless without a secret. Mirrors recorder
      // disable; failure is fine (the permission may already be gone).
      try {
        await chrome.permissions.remove({ origins: [CRM_ORIGIN_PATTERN] });
      } catch {
        // ignore
      }
      break;

    // Company brain sync (Settings). setBrainSyncToken is the ONE inbound path
    // for the per-employee token; no reply ever carries it back out.
    case 'setBrainSyncToken': {
      const token = msg.token.trim();
      if (!token) return { type: 'error', message: 'a sync token is required' };
      const existing = await getBrainSync();
      await setBrainSync({
        enabled: true,
        auto: existing?.auto ?? true,
        token,
        addedAt: new Date().toISOString(),
        lastSyncedAt: existing?.lastSyncedAt ?? null,
      });
      break;
    }

    case 'setBrainSyncEnabled': {
      const existing = await getBrainSync();
      if (!existing) return { type: 'error', message: 'save the sync token first' };
      await setBrainSync({ ...existing, enabled: msg.enabled });
      break;
    }

    case 'setBrainSyncAuto': {
      const existing = await getBrainSync();
      if (!existing) return { type: 'error', message: 'save the sync token first' };
      await setBrainSync({ ...existing, auto: msg.auto });
      break;
    }

    case 'clearBrainSync':
      await setBrainSync(null);
      // The admin.nanoforgeflow.com origin grant is deliberately NOT removed:
      // it is shared with the CRM sync, which may still be configured.
      break;

    case 'brainSyncNow': {
      const result = await syncBrainToCompany();
      return { type: 'brainSyncResult', ok: result.ok, message: result.message };
    }

    case 'testAdminSync':
      return { type: 'adminSyncTest', ...(await (msg.which === 'crm' ? testCrmSync() : testBrainSync())) };

    // Per-node company-sync flags. Written where the synced brain lives —
    // the paired server's files when paired (companySync pushes its export),
    // else the local BYOK brain.
    case 'setNodeFlags': {
      const flags: { private?: boolean; shared?: boolean } = {};
      if (typeof msg.private === 'boolean') flags.private = msg.private;
      if (typeof msg.shared === 'boolean') flags.shared = msg.shared;
      if (flags.private === undefined && flags.shared === undefined) {
        return { type: 'error', message: 'nothing to change' };
      }
      const pairing = await getPairing();
      if (pairing) {
        try {
          await setNodeFlagsOnServer(pairing.port, pairing.token, msg.id, flags);
        } catch (err) {
          return { type: 'error', message: err instanceof Error ? err.message : 'could not reach the brain' };
        }
      } else {
        await mutateLocalBrain((brain) => {
          const node = brain.nodes.find((n) => n.id === msg.id);
          if (!node) return;
          if (flags.private !== undefined) node.private = flags.private || undefined;
          if (flags.shared !== undefined) node.shared = flags.shared || undefined;
        });
      }
      break;
    }

    case 'setBrainMode':
      if (msg.mode !== 'paired' && msg.mode !== 'byok') return { type: 'error', message: 'unknown brain mode' };
      await setBrainModePref(msg.mode);
      break;

    case 'importBrainFromServer': {
      const pairing = await getPairing();
      if (!pairing) return { type: 'error', message: 'pair with `nff-brain serve` first — there is no server to import from' };
      try {
        const exported = await getExport(pairing.port, pairing.token);
        const { imported, total } = await mergeImportedBrain(exported.nodes, exported.edges);
        return { type: 'brainImported', imported, total };
      } catch (err) {
        return { type: 'error', message: err instanceof Error ? err.message : 'could not reach the brain' };
      }
    }

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

    // Web-agent action engine (CDP). Works in BYOK/standalone mode (the loop
    // uses the provider key); paired mode has no provider so the run reports
    // "add an API key" — the paired generic loop is a later milestone.
    case 'actStart': {
      const res = await startActionRun(msg.goal, msg.tabId, msg.maxActions, msg.workflowId, msg.mode, msg.codeEnabled);
      if (!res.ok) return { type: 'error', message: res.error ?? 'could not start the run' };
      return { type: 'actStatus', run: await getActRun() };
    }

    // Coding agent: project attach/detach/status + the per-run auto-approve
    // toggle. The panel already stored (or cleared) the folder HANDLE in
    // IndexedDB before sending these — showDirectoryPicker needs its window
    // context — so the SW only manages the JSON metadata and answers status.
    case 'codeAttached':
      await setCodeProject({ name: msg.name, attachedAt: new Date().toISOString() });
      return { type: 'codeStatus', project: await getCodeProject(), permission: await queryProjectPermission() };

    case 'codeDetach':
      await clearProjectHandle();
      await setCodeProject(null);
      return { type: 'codeStatus', project: null, permission: 'missing' };

    case 'getCodeStatus':
      return { type: 'codeStatus', project: await getCodeProject(), permission: await queryProjectPermission() };

    case 'codeAutoApprove':
      await setCodeAutoApprove(msg.enabled);
      return { type: 'actStatus', run: await getActRun() };

    case 'getWorkflows': {
      // Local store ∪ server list (server wins metadata on id collision), so
      // BYOK lists its locally distilled + previously imported workflows and
      // paired mode opportunistically refreshes the local cache as a side
      // effect (fire-and-forget — a slow sync must not delay the reply).
      const localItems = await listLocalWorkflows();
      const pairing = await getPairing();
      if (!pairing) return { type: 'workflows', items: localItems };
      void syncWorkflowsFromServer(pairing);
      try {
        const res = await getWorkflowsFromServer(pairing.port, pairing.token);
        const merged = [...res.items, ...localItems.filter((l) => !res.items.some((s) => s.id === l.id))];
        return { type: 'workflows', items: merged };
      } catch {
        return { type: 'workflows', items: localItems };
      }
    }

    case 'actStop':
      await stopActionRun();
      return { type: 'actStatus', run: await getActRun() };

    case 'actEnd':
      await endActionRun();
      return { type: 'actStatus', run: null };

    case 'actGrant':
      await answerPendingGrant(msg.choice);
      return { type: 'actStatus', run: await getActRun() };

    case 'getActStatus':
      return { type: 'actStatus', run: await getActRun() };

    case 'revokeActOrigin': {
      const state = await getActHostAllow();
      delete state.byOrigin[msg.origin];
      await setActHostAllow(state);
      break;
    }

    // Record-and-automate.
    case 'traceStart': {
      const res = await startTraceRecording(msg.tabId);
      if (!res.ok) return { type: 'error', message: res.error ?? 'could not start recording' };
      return traceStatus();
    }

    case 'traceStop': {
      const rec = await stopTraceRecording();
      // Distill mode-routed (mode.ts), fire-and-forget either way — the panel
      // polls tracePending, which the distiller clears on success. Paired:
      // server-side via /v1/trace (a brain node). BYOK: in the browser via
      // the provider's cheap background slot, into the local workflow store.
      // Unconfigured: the recording stays queued in tracePending rather than
      // being distilled anywhere; nothing is lost silently.
      if (rec && rec.events.length > 0) {
        const traceMode = await resolveBrainMode();
        if (traceMode === 'paired') {
          const pairing = await getPairing();
          if (pairing) void distillPairedTrace(pairing);
        } else if (traceMode === 'byok') {
          void distillPendingTrace();
        }
      }
      return traceStatus();
    }

    case 'traceCancel':
      await cancelTraceRecording();
      return traceStatus();

    case 'getTraceStatus':
      return traceStatus();

    // Record LinkedIn network (support capture).
    case 'netCaptureStart':
      await startNetCapture(msg.tabId);
      return { type: 'netCapture', started: true, entries: [] };

    case 'netCaptureDownload':
      return { type: 'netCapture', started: false, entries: await dumpNetCapture(msg.tabId) };
  }
  return { type: 'state', state: await publicState() };
}

async function traceStatus(): Promise<SwToPopup> {
  const [active, pending] = await Promise.all([getTraceActive(), getTracePending()]);
  return {
    type: 'traceStatus',
    recording: !!active?.recording,
    eventCount: active?.events.length ?? 0,
    pending: pending ? { id: pending.id, events: pending.events.length, startUrl: pending.startUrl, title: pending.title } : null,
  };
}

/**
 * The user clicking the debugger infobar's "Cancel" detaches us — treat it (and
 * a target-gone detach) as a Stop, so the run doesn't sit "running" over a tab
 * it can no longer drive. Guarded because chrome.debugger only exists once the
 * OPTIONAL permission is granted; without the guard this throws at worker start.
 */
async function onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): Promise<void> {
  const run = await getActRun();
  if (run && source.tabId === run.tabId && (run.phase === 'running' || run.phase === 'awaiting_grant' || run.phase === 'stopping')) {
    // Best-effort only: Chrome notifies AFTER the debugger is already gone —
    // there is no "about to detach" hook to beat that race — so this CDP
    // evaluate will usually no-op silently and the glow border/Stop pill are
    // left showing, inert, on the page until it next navigates or reloads.
    // Same class of gap as the cursor overlay having no cleanup on this path.
    if (source.tabId !== undefined) {
      await attentionHide(source.tabId);
      await cursorHide(source.tabId);
    }
    await mutateActRun((r) => {
      r.phase = 'stopped';
      r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: `Debugger detached (${reason}). Run stopped.` });
    });
  }
}

async function onInstalled(): Promise<void> {
  // MERGE, never overwrite: onInstalled also fires with reason 'update' on every
  // extension update, and storage.set(DEFAULTS) there would re-enable capture
  // and wipe the allowlist behind the user's back.
  await seedDefaults();
  createMenus();
  // A persistent browser-side setting (like the menus above) — no manifest
  // default_popup means the toolbar icon has no built-in click behavior at
  // all until this is set. Setting it once here (not resent on every SW
  // wake) is Chrome's own documented pattern.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Registered content scripts are cleared on every extension update —
  // reconcile them against stored recorder AND agent-adapter state here,
  // idempotently.
  await ensureRecorderScripts();
  await ensureAgentScripts();
  // An extension update clears dynamically-registered scripts, so a recording in
  // progress can no longer receive events — freeze what it captured rather than
  // leave it dangling.
  if ((await getTraceActive())?.recording) await stopTraceRecording();
  await ensureAlarm();
  // Re-arm the clip drain in case an update landed with clips still queued.
  await ensureDrainAlarm();
  await paintBadge(await currentPhase(), (await getCapture()).enabled);
}

async function onStartup(): Promise<void> {
  // Deliberately does NOT write nb.capture — pause must survive a restart.
  await ensureAlarm();
  await probe();
  // A recording cannot survive a browser restart (its content script is gone) —
  // freeze the captured events into the pending slot instead of losing them.
  if ((await getTraceActive())?.recording) await stopTraceRecording();
  // chrome.alarms survive a browser restart, so a mid-run nb.agentPoll alarm
  // should still fire on its own — this is just insurance in case it didn't.
  void pollAgent();
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
    return;
  }
  // Auto company sync — the one-shot debounce armed by brainStore.ts after a
  // local brain mutation. syncBrainToCompany() re-checks the toggles itself.
  if (alarm.name === 'brainSync') {
    await syncBrainToCompany();
  }
}

// ── registration, synchronous, top level ────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => void onInstalled());
chrome.runtime.onStartup.addListener(() => void onStartup());
chrome.alarms.onAlarm.addListener((alarm) => void onAlarm(alarm));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void onMenuClicked(info, tab);
  void onCrmMenuClicked(info, tab);
});
chrome.permissions.onAdded.addListener(() => void probe({ force: true }));
// Page-visit log → activity history ("Navigated to LinkedIn — …"). Needs only
// the `tabs` permission already declared; the handler re-checks nb.logVisits.
// capturePageVisit is the separate, allowlist-gated passive content reader —
// see its own file header for why it cannot share logVisit's ungated tap.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  void logVisit(info, tab);
  void capturePageVisit(tabId, info, tab);
});
// Guarded: chrome.debugger is present only while the optional `debugger`
// permission is granted. Registered here (top level) so an infobar Cancel is
// heard whenever the permission was already granted at worker start.
if (chrome.debugger) chrome.debugger.onDetach.addListener((source, reason) => void onDebuggerDetach(source, reason));
// LinkedIn invite detection at the NETWORK level (see inviteNet.ts): the
// Voyager invite POST is locale-independent and observed here in the SW, so
// stale tabs and shadow-DOM modals can't lose it. Events only flow while the
// linkedin.com optional host is granted (i.e. the recorder was enabled);
// the handler re-checks the recorder toggle itself.
chrome.webRequest.onCompleted.addListener(
  (details) => void onLinkedinInviteRequest(details),
  { urls: ['https://www.linkedin.com/voyager/api/*'], types: ['xmlhttprequest'] },
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Recorder events come from content scripts, are fire-and-forget, and must
  // never flow into the handleMessage() switch (their sender matters).
  if ((msg as { type?: string })?.type === 'recorderEvent') {
    void onRecorderEvent(msg, sender);
    sendResponse({ type: 'state' }); // ack; content scripts ignore replies
    return true;
  }
  // Task-recorder events (record-and-automate) — also from a content script,
  // fire-and-forget, and their sender matters (the SW stamps the trusted url).
  if ((msg as { type?: string })?.type === 'traceEvent') {
    void onTraceEvent((msg as { event?: unknown }).event, sender);
    sendResponse({ type: 'state' });
    return true;
  }
  // LinkedIn network-tap summaries forwarded by content/linkedin.ts — again a
  // content script, fire-and-forget, sender-matters (recorder toggle + url gate).
  if ((msg as { type?: string })?.type === 'linkedinNet') {
    void onLinkedinNet((msg as { payload?: unknown }).payload, sender);
    sendResponse({ type: 'state' });
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
