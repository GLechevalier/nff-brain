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
import {
  acceptSeenHas,
  acceptSeenPut,
  classifyAcceptedFromResponse,
  classifyInviteRequest,
  classifyMessageSend,
  dayBucket,
  endpointOf,
  nameFromTabTitle,
  parseMessageText,
  pushNetLog,
  pushPendingInvite,
  takePendingInvite,
  type NetTapPayload,
  type PendingInvite,
} from './inviteNet.js';
import { scrapeProfileTopCard, type ProfileTopCard } from './profileScrapeScript.js';
import { canonicalProfileUrl } from '../content/linkedinClassify.js';
import { parseCardText } from '../content/linkedinAgentClassify.js';
import { resolveBrainMode } from './mode.js';
import { enqueueStandaloneClip } from './standaloneDrain.js';
import { ADAPTERS, adapterById } from './recorderRegistry.js';
import { formatRecorderClip, pushRecorderSeen, recorderSeenRecently, validateRecorderEvent } from './recorderFormat.js';
import type { RecorderEventMsg } from './recorderTypes.js';
import {
  getAcceptSeen,
  getAllowlist,
  getCapture,
  getInvitePending,
  getNetLog,
  getPairing,
  getRecorderSeen,
  getRecorders,
  setAcceptSeen,
  setAllowlist,
  setInvitePending,
  setNetLog,
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

    // The MAIN-world network tap (LinkedIn). Registered as its own script in the
    // page's world at document_start so it wraps fetch/XHR before the LinkedIn
    // app makes its first call. Same enable+grant gate as the isolated script.
    if (adapter.mainWorldScriptFile) {
      const netId = `rec.${adapter.id}.net`;
      if (want && !registeredIds.has(netId)) {
        await chrome.scripting.registerContentScripts([
          {
            id: netId,
            js: [adapter.mainWorldScriptFile],
            matches: adapter.matches,
            runAt: 'document_start',
            world: 'MAIN',
            persistAcrossSessions: true,
          },
        ]);
      } else if (!want && registeredIds.has(netId)) {
        await chrome.scripting.unregisterContentScripts({ ids: [netId] });
      }
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
 * click path (see inviteNet.ts). Identity: a recent Connect-button click on
 * the tab (nb.invitePending — names the invitee even on browsemap/search/
 * My-Network surfaces) wins; else the TAB's own url + title, which is only
 * honest on /in/ profile pages.
 * The invite note rides in on the modal-Send click's correlation record
 * (nb.invitePending) — no request body read needed.
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

  // A recent Connect-button click on this tab carries the INVITEE's identity
  // (content/linkedin.ts read it off the button itself) — the honest source
  // when the invite went to a browsemap-sidebar / search / My-Network card
  // rather than the page's own profile. Consume it; without one, fall back to
  // the tab's identity exactly as before (only valid on /in/ pages).
  const nowMs = Date.now();
  let take = takePendingInvite(await getInvitePending(), details.tabId, nowMs);
  if (!take.entry) {
    // The click message may still be in flight behind this webRequest event —
    // one short retry before concluding there was no correlating click.
    await new Promise((r) => setTimeout(r, 250));
    take = takePendingInvite(await getInvitePending(), details.tabId, Date.now());
  }
  await setInvitePending(take.rest);

  let name: string;
  let linkedin: string;
  const invitee: PendingInvite | null = take.entry;
  if (invitee?.slug) {
    if (!invitee.name) {
      // Slug known but no click named the person (unparsed locale) — skip
      // rather than misattribute to the tab. The breadcrumb names the gap.
      console.debug('[nff-brain] invite pending has no name — skipped', invitee.slug);
      return;
    }
    name = invitee.name;
    // Slug is authoritative: a merged modal-Send entry's dialog-derived
    // linkedin can name the PAGE's profile, never trust it over the slug.
    linkedin = `https://www.linkedin.com/in/${invitee.slug}`;
  } else {
    // No invitee-identity click (or a modal-Send-only entry, which carries the
    // note but claims no identity) — the tab is the honest source, /in/ only.
    linkedin = canonicalProfileUrl(url);
    if (!linkedin) return; // not a profile page — no honest identity, never guess
    name = invitee?.name || nameFromTabTitle(tab.title ?? '');
    if (!name) return;
  }

  // Best-effort enrichment scrape — see profileScrapeScript.ts for the
  // self-containment rule. With a pending-click invitee, the scrape is pointed
  // at THEIR slug (voyager-blob match only; the page's top card names someone
  // else). Any failure degrades to name+linkedin; never load-bearing.
  let scraped: ProfileTopCard = { name: '', headline: '', location: '' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: scrapeProfileTopCard,
      args: [invitee?.slug ?? ''],
    });
    if (res?.result) scraped = res.result as ProfileTopCard;
    console.debug('[nff-brain] profile scrape', JSON.stringify(scraped).slice(0, 300));
  } catch (err) {
    // no scripting access / tab gone — enrichment simply absent
    console.debug('[nff-brain] profile scrape failed', err instanceof Error ? err.message : String(err));
  }
  const parsed = parseCardText(scraped.name || name, scraped.headline);

  // Scraped page text is UNTRUSTED — route the whole event through the same
  // validator the content-script sink uses (clamps keys/values, drops junk).
  const msg = validateRecorderEvent({
    type: 'recorderEvent',
    adapter: 'linkedin',
    action: 'linkedin.invite_sent',
    // Same key shape as content/linkedin.ts — the nb.recorderSeen ring is what
    // collapses a click-path and net-path double-observation into one event.
    key: `linkedin.invite_sent:${name}:${dayBucket()}`,
    at: new Date().toISOString(),
    title: `Invited ${name} to connect`,
    fields: {
      name,
      linkedin,
      ...(invitee?.note && { note: invitee.note }),
      ...(parsed.headline && { headline: parsed.headline }),
      ...(parsed.company && { company: parsed.company }),
      ...(parsed.headline && parsed.role !== parsed.headline && { role: parsed.role }),
      ...(scraped.location && { location: scraped.location }),
    },
  });
  if (!msg) return;
  await deliverRecorderClip(url, msg);
}

/**
 * The MAIN-world network tap sink (message type 'linkedinNet', forwarded by
 * content/linkedin.ts). Turns a tapped voyager call into: a metadata-only
 * net-log row for anything untracked (nothing invisible), a message-sent
 * interaction, or one accept per newly-connected person. Classification is the
 * pure inviteNet.ts functions; identity/bodies are re-validated here (the page
 * is untrusted). Recorder-toggle + shouldCapture gate exactly as the other
 * paths do.
 */
export async function onLinkedinNet(raw: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.id !== chrome.runtime.id) return;
  const url = sender.tab?.url;
  if (!url) return;
  // Untrusted page-derived payload — coerce to a known shape, never assume it.
  if (typeof raw !== 'object' || raw === null) return;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || typeof r.method !== 'string') return;
  const payload: NetTapPayload = {
    url: r.url,
    method: r.method,
    status: typeof r.status === 'number' ? r.status : 0,
    reqBody: typeof r.reqBody === 'string' ? r.reqBody : undefined,
    resBody: typeof r.resBody === 'string' ? r.resBody : undefined,
    recipientName: typeof r.recipientName === 'string' ? r.recipientName : undefined,
    recipientLinkedin: typeof r.recipientLinkedin === 'string' ? r.recipientLinkedin : undefined,
  };
  const state = await getRecorders();
  if (state.byId['linkedin']?.enabled !== true) return;

  const isMsg = classifyMessageSend(payload.method, payload.url);
  const accepted = classifyAcceptedFromResponse(payload.url, payload.resBody);

  // A tracked kind delivers a clip; anything else (or a message we could not
  // attribute to a recipient) falls through to the metadata-only net-log — the
  // ledger that keeps an un-classified endpoint visible for the next classifier.
  let recorded = false;
  if (isMsg) recorded = await onLinkedinMessageSent(payload, url);
  if (accepted.length) {
    await onLinkedinAccepted(accepted, url);
    recorded = true; // handled (a baselined first run records nothing, by design)
  }
  if (recorded) return;

  const log = await getNetLog();
  await setNetLog(
    pushNetLog(log, {
      atMs: Date.now(),
      method: payload.method,
      endpoint: endpointOf(payload.url),
      status: payload.status,
    }),
  );
}

/** A message you sent → a linkedin.message_sent clip on the recipient, when the
 *  content-side thread scrape named them. Returns false (⇒ net-log it instead)
 *  when the thread named nobody — never a mystery contact. */
async function onLinkedinMessageSent(payload: NetTapPayload, tabUrl: string): Promise<boolean> {
  const name = (payload.recipientName ?? '').trim().slice(0, 80);
  if (!name) return false; // group/unknown thread — fall through to the net-log
  const text = parseMessageText(payload.reqBody);
  const at = new Date().toISOString();
  const msg = validateRecorderEvent({
    type: 'recorderEvent',
    adapter: 'linkedin',
    action: 'linkedin.message_sent',
    // Second-resolution timestamp in the key: an exact double-fire of the same
    // POST collapses, but two genuinely separate messages stay distinct rows.
    key: `linkedin.message_sent:${name}:${at.slice(0, 19)}`,
    at,
    title: `Messaged ${name}`,
    fields: {
      name,
      ...(payload.recipientLinkedin && { linkedin: payload.recipientLinkedin }),
      ...(text && { message: text }),
    },
  });
  if (!msg) return false;
  await deliverRecorderClip(tabUrl, msg);
  return true;
}

/**
 * The "recently added connections" response names people who accepted you.
 * First run baselines the current list silently (nb.acceptSeen empty) so we
 * only ever report accepts that land AFTER tracking is on; thereafter each new
 * slug is one linkedin.invite_accepted clip, deduped across days by the map.
 */
async function onLinkedinAccepted(accepted: { slug: string; name: string }[], tabUrl: string): Promise<void> {
  const nowMs = Date.now();
  let seen = await getAcceptSeen();
  const firstRun = Object.keys(seen).length === 0;
  const toReport: { slug: string; name: string }[] = [];
  for (const a of accepted) {
    if (acceptSeenHas(seen, a.slug, nowMs)) continue;
    seen = acceptSeenPut(seen, a.slug, nowMs);
    if (!firstRun) toReport.push(a);
  }
  await setAcceptSeen(seen);
  if (firstRun) {
    console.debug('[nff-brain] accept baseline —', accepted.length, 'existing connections recorded silently');
    return;
  }
  for (const a of toReport) {
    const at = new Date().toISOString();
    const msg = validateRecorderEvent({
      type: 'recorderEvent',
      adapter: 'linkedin',
      action: 'linkedin.invite_accepted',
      key: `linkedin.invite_accepted:${a.slug}`,
      at,
      title: `${a.name} accepted your invite`,
      fields: { name: a.name, linkedin: `https://www.linkedin.com/in/${a.slug}` },
    });
    if (msg) await deliverRecorderClip(tabUrl, msg);
  }
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

  // A Connect-button or modal-Send click is a CORRELATION record, not an
  // invite: park what the click knows (invitee slug/linkedin from a Connect
  // button; name/note from the modal) for onLinkedinInviteRequest to merge
  // when (if) the voyager POST confirms the invite. Never delivered as a
  // clip — no activity row, no seen-ring entry, no CRM contact for a click
  // that sent nothing.
  if (msg.action === 'linkedin.connect_click') {
    const tabId = sender.tab?.id;
    const linkedin = msg.fields.linkedin ?? '';
    // Only Connect-button entries carry `slug` (read off the button's own
    // preload href) — a modal-Send entry's linkedin is dialog-derived (may be
    // the page's own profile) and must never masquerade as invitee identity.
    const slug = msg.fields.slug ?? '';
    const name = msg.fields.name ?? '';
    const note = msg.fields.note ?? '';
    if (tabId === undefined || tabId < 0 || (!slug && !name && !note)) return;
    const nowMs = Date.now();
    const pending = await getInvitePending();
    await setInvitePending(pushPendingInvite(pending, { tabId, name, linkedin, slug, note, atMs: nowMs }, nowMs));
    return;
  }

  await deliverRecorderClip(url, msg);
}
