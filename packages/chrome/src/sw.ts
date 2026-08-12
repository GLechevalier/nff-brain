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
import { getNodes, retract, searchBrain } from './client.js';
import { HEALTH_ALARM, currentPhase, ensureAlarm, pairWithServer, probe, unpair } from './connection.js';
import { clearActivity, removableNodeCount } from './activity.js';
import { parseRuleInput, ruleLabel } from './gate.js';
import { derivePhase } from './health.js';
import { ensureRecorderScripts, onRecorderEvent, recorderPublicState, setRecorderEnabled } from './recorder.js';
import { getActivity, getAllowlist, getCapture, getHealth, getPairing, seedDefaults, setAllowlist, setCapture } from './storage.js';
import type { PopupToSw, PublicState, SwToPopup } from './protocol.js';

async function publicState(): Promise<PublicState> {
  const [pairing, health, capture, allowlist, activity] = await Promise.all([
    getPairing(),
    getHealth(),
    getCapture(),
    getAllowlist(),
    getActivity(),
  ]);
  const { nextProbeAtMs, ...rest } = health;
  void nextProbeAtMs; // internal scheduling; the popup has no use for it
  return {
    phase: derivePhase(health, pairing !== null, Date.now()),
    port: pairing?.port ?? null,
    health: rest,
    capture,
    rules: allowlist.rules,
    activityCount: activity.length,
    removableNodeCount: removableNodeCount(activity),
    recorders: await recorderPublicState(),
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
  // reconcile them against stored recorder state here, idempotently.
  await ensureRecorderScripts();
  await ensureAlarm();
  await paintBadge(await currentPhase(), (await getCapture()).enabled);
}

async function onStartup(): Promise<void> {
  // Deliberately does NOT write nb.capture — pause must survive a restart.
  await ensureAlarm();
  await probe();
}

async function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== HEALTH_ALARM) return;
  await probe();
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
