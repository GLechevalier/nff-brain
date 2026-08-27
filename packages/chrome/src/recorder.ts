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
import { maybeSyncCrmContact } from './crmSync.js';
import { isAllowed, shouldCapture } from './gate.js';
import { classifyInviteRequest, dayBucket, nameFromTabTitle } from './inviteNet.js';
import { canonicalProfileUrl } from '../content/linkedinClassify.js';
import { resolveBrainMode } from './mode.js';
import { enqueueStandaloneClip } from './standaloneDrain.js';
import { ADAPTERS, adapterById } from './recorderRegistry.js';
import { formatRecorderClip, pushRecorderSeen, recorderSeenRecently, validateRecorderEvent } from './recorderFormat.js';
import type { RecorderEventMsg } from './recorderTypes.js';
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

/**
 * The gate→dedupe→post-clip tail, shared by every real caller of the clip
 * pipeline: the content-script event sink below, AND (item 7) agentRunner.ts
 * for a real, agent-caused LinkedIn connect. Deliberately stays inside this
 * file — bundlePurity.test.ts pins shouldCapture()'s callers to exactly
 * ['src/capture.ts', 'src/recorder.ts'], and keeping the agent's audit-clip
 * write as an internal caller of THIS file (never a new one) is what keeps
 * that invariant true without editing the test.
 *
 * `url` is the caller's OWN best evidence of where this happened — a
 * sender.tab.url claim from a content script, or a chrome.tabs.get() lookup
 * the service worker did itself for an agent-driven tab it is controlling.
 * Either way it is never a raw, unchecked claim from untrusted page content.
 */
export async function deliverRecorderClip(url: string, msg: RecorderEventMsg): Promise<void> {
  const [capture, allowlist] = await Promise.all([getCapture(), getAllowlist()]);
  // THE CHOKE POINT. Global pause and allowlist removal silence a recorder —
  // passive OR agent-driven — right here, with zero extra code either way.
  if (!shouldCapture(url, { enabled: capture.enabled, rules: allowlist.rules })) return;

  // Persistent dedupe (a submit can double-fire; a page-load Set died with the
  // navigation; an agent-caused connect and a simultaneously-enabled passive
  // recorder can independently observe the SAME real click — this ring is
  // what collapses that into one clip, whichever path posts first).
  const nowMs = Date.now();
  const ring = await getRecorderSeen();
  if (recorderSeenRecently(ring, msg.key, nowMs)) return;
  await setRecorderSeen(pushRecorderSeen(ring, msg.key, nowMs));

  // CRM sync (LinkedIn invites → nff-admin). After the choke point and the
  // ring so pause/allowlist and the per-day key govern it; before the mode
  // fork so paired and BYOK sync identically. Never throws, no-op unless
  // configured — see crmSync.ts.
  await maybeSyncCrmContact(msg);

  const { text, title } = formatRecorderClip(msg);
  const pairing = await getPairing();
  const id = crypto.randomUUID();
  await appendActivity({ id, url, title, text, delivery: 'pending' });

  if (!pairing || (await resolveBrainMode()) === 'byok') {
    // Same routing as capture.ts — BYOK (or nothing configured) goes to the
    // local clip pipeline; the drain distills once a key exists.
    await enqueueStandaloneClip({ kind: 'note', text, url, title, capturedAt: msg.at }, id);
    setTimeout(() => {
      void currentPhase().then((phase) => paintBadge(phase, capture.enabled));
    }, 1200);
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

/**
 * The NETWORK event sink: LinkedIn's own Voyager invite POST, observed via
 * chrome.webRequest (registered top-level in sw.ts). Locale-independent and
 * immune to stale tabs / shadow-DOM modals — the failure modes that killed the
 * click path (see inviteNet.ts). Identity comes from the TAB (url + title),
 * which the SW reads itself; only /in/ profile pages carry an honest name, so
 * invites sent from search/My-Network pages are skipped.
 * ponytail: no request body read — the invite note is lost on this path; add
 * an onBeforeRequest requestBody correlation if notes ever matter.
 */
export async function onLinkedinInviteRequest(details: {
  method: string;
  url: string;
  statusCode: number;
  tabId: number;
}): Promise<void> {
  const matched = classifyInviteRequest(details.method, details.url, details.statusCode);
  // Deliberate breadcrumb (SW console): LinkedIn renames these endpoints, and
  // this one line is what turns "invite didn't sync" into the URL to add to
  // the classifier. POSTs only — reads are noise.
  if (details.method.toUpperCase() === 'POST') {
    console.debug('[nff-brain] voyager POST', matched ? 'MATCHED' : 'ignored', details.url.slice(0, 200));
  }
  if (!matched) return;
  const state = await getRecorders();
  if (state.byId['linkedin']?.enabled !== true) return;
  if (details.tabId < 0) return;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return;
  }
  const url = tab.url ?? '';
  const linkedin = canonicalProfileUrl(url);
  if (!linkedin) return; // not a profile page — no honest identity, never guess
  const name = nameFromTabTitle(tab.title ?? '');
  if (!name) return;
  await deliverRecorderClip(url, {
    type: 'recorderEvent',
    adapter: 'linkedin',
    action: 'linkedin.invite_sent',
    // Same key shape as content/linkedin.ts — the nb.recorderSeen ring is what
    // collapses a click-path and net-path double-observation into one event.
    key: `linkedin.invite_sent:${name}:${dayBucket()}`,
    at: new Date().toISOString(),
    title: `Invited ${name} to connect`,
    fields: { name, linkedin },
  });
}

/** The content-script event sink — the second registered shouldCapture caller (via deliverRecorderClip). */
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

  await deliverRecorderClip(url, msg);
}
