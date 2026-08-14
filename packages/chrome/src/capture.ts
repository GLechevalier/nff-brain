// The capture verbs: right-click → "Remember this" (selection), "Remember this
// link" and "Remember this page".
//
// One entry point, and it routes through shouldCapture() like every future one
// must. Nothing here caches the capture flag or the allowlist — both are read
// from storage at the moment of the click, which is precisely what makes
// pausing take effect on the very next event rather than on the next page load.
// The gate always runs on the PAGE url (tab.url) — the page is what the user
// allowlisted, even when the thing remembered is a link on it.

import { appendActivity, markDelivery, pushRecent, recentKey, seenRecently } from './activity.js';
import { flashCaptured, paintBadge } from './badge.js';
import { HttpError, postClip } from './client.js';
import type { ClipPayload } from './client.js';
import { currentPhase } from './connection.js';
import { shouldCapture } from './gate.js';
import { resolveBrainMode } from './mode.js';
import { enqueueStandaloneClip } from './standaloneDrain.js';
import { getAllowlist, getCapture, getPairing, getRecent, setRecent } from './storage.js';

export const MENU_ID = 'nb.remember';
export const MENU_ID_LINK = 'nb.remember.link';
export const MENU_ID_PAGE = 'nb.remember.page';

/**
 * Chrome persists context menus across service-worker restarts, so re-creating
 * on every wake throws a duplicate-id error. Create once from onInstalled, and
 * swallow the duplicate defensively in case the two ever race.
 */
export function createMenus(): void {
  const items: Array<{ id: string; title: string; contexts: chrome.contextMenus.ContextType[] }> = [
    { id: MENU_ID, title: 'Remember this', contexts: ['selection'] },
    { id: MENU_ID_LINK, title: 'Remember this link', contexts: ['link'] },
    { id: MENU_ID_PAGE, title: 'Remember this page', contexts: ['page'] },
  ];
  for (const item of items) {
    try {
      chrome.contextMenus.create(
        item,
        () => void chrome.runtime.lastError, // reading it suppresses the console warning
      );
    } catch {
      /* already exists */
    }
  }
}

/** Build the payload per menu item; null when the click has nothing to keep. */
function buildPayload(
  menuItemId: string | number,
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): ClipPayload | null {
  const capturedAt = new Date().toISOString();
  if (menuItemId === MENU_ID) {
    const text = (info.selectionText ?? '').trim();
    if (!text) return null;
    return { kind: 'selection', text, url: tab?.url, title: tab?.title, capturedAt };
  }
  if (menuItemId === MENU_ID_LINK) {
    if (!info.linkUrl) return null;
    // The link's own text is not exposed by the menus API; the server accepts
    // url-only clips, and the drain reads the URL itself.
    return { kind: 'link', text: (info.selectionText ?? '').trim(), url: info.linkUrl, title: tab?.title, capturedAt };
  }
  if (menuItemId === MENU_ID_PAGE) {
    if (!tab?.url) return null;
    return { kind: 'page', text: '', url: tab.url, title: tab?.title, capturedAt };
  }
  return null;
}

export async function onMenuClicked(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (info.menuItemId !== MENU_ID && info.menuItemId !== MENU_ID_LINK && info.menuItemId !== MENU_ID_PAGE) return;

  const [capture, allowlist] = await Promise.all([getCapture(), getAllowlist()]);
  // THE CHOKE POINT. A paused extension, or a domain that is not on the list,
  // stops here — with no badge flash, so an unlisted site gives no signal at all.
  if (!shouldCapture(tab?.url, { enabled: capture.enabled, rules: allowlist.rules })) return;

  const payload = buildPayload(info.menuItemId, info, tab);
  if (!payload) return;

  // Dedupe: the same selection/link/page captured twice inside the window is
  // one clip. Silent — the first capture already flashed.
  const nowMs = Date.now();
  const key = recentKey(payload.kind, payload.url, payload.text);
  const ring = await getRecent();
  if (seenRecently(ring, key, nowMs)) return;
  await setRecent(pushRecent(ring, key, nowMs));

  const pairing = await getPairing();
  const id = crypto.randomUUID();
  await appendActivity({
    id,
    url: payload.url ?? tab?.url ?? '',
    title: payload.title ?? '',
    text: payload.text,
    delivery: 'pending',
  });

  if (!pairing || (await resolveBrainMode()) === 'byok') {
    // BYOK (or nothing configured): the clip goes to the LOCAL pipeline —
    // enqueueStandaloneClip queues even in 'unconfigured' mode so a note
    // captured before the user picked a setup path is never lost, and the
    // drain distills it once a key exists.
    await enqueueStandaloneClip(payload, id);
    setTimeout(() => {
      void currentPhase().then((phase) => paintBadge(phase, capture.enabled));
    }, 1200);
    return;
  }

  try {
    const res = await postClip(pairing.port, pairing.token, payload);
    // The server clip id is the join key the clips-map poll uses to fill
    // nodeIds later — without it "also remove nodes" can never light up.
    await markDelivery(id, 'delivered', res.id);
    await flashCaptured(true);
  } catch (err) {
    await markDelivery(id, 'failed');
    await flashCaptured(false);
    void (err instanceof HttpError ? err.message : err);
  }

  // Restore the steady-state badge shortly after the confirmation flash.
  setTimeout(() => {
    void currentPhase().then((phase) => paintBadge(phase, capture.enabled));
  }, 1200);
}
