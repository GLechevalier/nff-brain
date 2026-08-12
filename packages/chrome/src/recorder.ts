// SW-side recorder orchestration: dynamic content-script registration and the
// event handler. Mirrors capture.ts step for step — a recorder event is just a
// capture whose entry point is a content script instead of a context menu, and
// it routes through the SAME shouldCapture() choke point with storage read
// fresh at event time. Pausing, allowlist removal and default-deny therefore
// gate recorders with zero extra code.

import { appendActivity, markDelivery } from './activity.js';
import { flashCaptured, paintBadge } from './badge.js';
import { HttpError, postClip } from './client.js';
import { currentPhase } from './connection.js';
import { isAllowed, shouldCapture } from './gate.js';
import { ADAPTERS, adapterById } from './recorderRegistry.js';
import { formatRecorderClip, pushRecorderSeen, recorderSeenRecently, validateRecorderEvent } from './recorderFormat.js';
import {
  getAllowlist,
  getCapture,
  getPairing,
  getRecorderSeen,
  getRecorders,
  setAllowlist,
  setRecorderSeen,
  setRecorders,
} from './storage.js';

/**
 * Reconcile chrome.scripting registrations against stored recorder state.
 * Called from onInstalled (registered scripts are CLEARED on extension update)
 * and after every enable/disable. Idempotent: registered-but-disabled scripts
 * are removed, enabled-but-unregistered ones (with the permission still
 * granted) are re-registered.
 */
export async function ensureRecorderScripts(): Promise<void> {
  const state = await getRecorders();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map((s) => s.id));

  for (const adapter of ADAPTERS) {
    const wantEnabled = state.byId[adapter.id]?.enabled === true;
    const granted = await chrome.permissions.contains({ origins: adapter.originPatterns });
    const scriptId = `rec.${adapter.id}`;
    const want = wantEnabled && granted;

    if (want && !registeredIds.has(scriptId)) {
      await chrome.scripting.registerContentScripts([
        {
          id: scriptId,
          js: [adapter.scriptFile],
          matches: adapter.matches,
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ]);
    } else if (!want && registeredIds.has(scriptId)) {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    }
  }
}

/**
 * Flip a recorder. The popup has already run chrome.permissions.request (a
 * user gesture is required there, not here). Enable also adds the adapter's
 * hosts to the allowlist — the allowlist IS the safety boundary, and a
 * recorder the user cannot see in the domain list would be a hidden recorder.
 * Disable releases the host permission: toggle-off means the permission is
 * GONE, verifiable in chrome://extensions.
 */
export async function setRecorderEnabled(id: string, enabled: boolean): Promise<string | null> {
  const adapter = adapterById(id);
  if (!adapter) return 'unknown recorder';

  const state = await getRecorders();
  state.byId[id] = { enabled, changedAt: new Date().toISOString() };
  await setRecorders(state);

  if (enabled) {
    const allowlist = await getAllowlist();
    for (const host of adapter.hosts) {
      const existing = allowlist.rules.find((r) => r.host === host);
      if (!existing) {
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
  }
  await ensureRecorderScripts();
  return null;
}

/** Popup state for the Recorders section. */
export async function recorderPublicState(): Promise<
  Array<{ id: string; label: string; hosts: string[]; enabled: boolean; granted: boolean; allowlisted: boolean }>
> {
  const [state, allowlist] = await Promise.all([getRecorders(), getAllowlist()]);
  const out = [];
  for (const adapter of ADAPTERS) {
    out.push({
      id: adapter.id,
      label: adapter.label,
      hosts: adapter.hosts,
      enabled: state.byId[adapter.id]?.enabled === true,
      granted: await chrome.permissions.contains({ origins: adapter.originPatterns }),
      // gate.ts owns host matching — never a second copy of that logic.
      allowlisted: adapter.hosts.every((h) => isAllowed(`https://${h}/`, allowlist.rules)),
    });
  }
  return out;
}

/** The content-script event sink — the second registered shouldCapture caller. */
export async function onRecorderEvent(raw: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  // Only our own content scripts, and only ones running in a real tab.
  if (sender.id !== chrome.runtime.id) return;
  const url = sender.tab?.url;
  if (!url) return;

  const msg = validateRecorderEvent(raw);
  if (!msg) return;
  const adapter = adapterById(msg.adapter);
  if (!adapter || !adapter.actions.includes(msg.action)) return;
  const state = await getRecorders();
  if (state.byId[msg.adapter]?.enabled !== true) return;

  const [capture, allowlist] = await Promise.all([getCapture(), getAllowlist()]);
  // THE CHOKE POINT, on the SENDER'S url — never the script's claim. Global
  // pause and allowlist removal silence an injected recorder right here.
  if (!shouldCapture(url, { enabled: capture.enabled, rules: allowlist.rules })) return;

  // Persistent dedupe (a submit can double-fire; a page-load Set died with the
  // navigation). In storage, never a module variable.
  const nowMs = Date.now();
  const ring = await getRecorderSeen();
  if (recorderSeenRecently(ring, msg.key, nowMs)) return;
  await setRecorderSeen(pushRecorderSeen(ring, msg.key, nowMs));

  const { text, title } = formatRecorderClip(msg);
  const pairing = await getPairing();
  const id = crypto.randomUUID();
  await appendActivity({ id, url, title, text, delivery: 'pending' });

  if (!pairing) {
    await markDelivery(id, 'failed');
    await flashCaptured(false);
    return;
  }
  try {
    const res = await postClip(pairing.port, pairing.token, {
      kind: 'note',
      text,
      url,
      title,
      capturedAt: msg.at,
    });
    await markDelivery(id, 'delivered', res.id);
    await flashCaptured(true);
  } catch (err) {
    await markDelivery(id, 'failed');
    await flashCaptured(false);
    void (err instanceof HttpError ? err.message : err);
  }

  setTimeout(() => {
    void currentPhase().then((phase) => paintBadge(phase, capture.enabled));
  }, 1200);
}
