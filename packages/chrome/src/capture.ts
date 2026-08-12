// The capture verb: right-click a text selection → "Remember this".
//
// One entry point, and it routes through shouldCapture() like every future one
// must. Nothing here caches the capture flag or the allowlist — both are read
// from storage at the moment of the click, which is precisely what makes
// pausing take effect on the very next event rather than on the next page load.

import { appendActivity, markDelivery } from './activity.js';
import { flashCaptured, paintBadge } from './badge.js';
import { HttpError, postClip } from './client.js';
import { currentPhase } from './connection.js';
import { shouldCapture } from './gate.js';
import { getAllowlist, getCapture, getPairing } from './storage.js';

export const MENU_ID = 'nb.remember';

/**
 * Chrome persists context menus across service-worker restarts, so re-creating
 * on every wake throws a duplicate-id error. Create once from onInstalled, and
 * swallow the duplicate defensively in case the two ever race.
 */
export function createMenus(): void {
  try {
    chrome.contextMenus.create(
      { id: MENU_ID, title: 'Remember this', contexts: ['selection'] },
      () => void chrome.runtime.lastError, // reading it suppresses the console warning
    );
  } catch {
    /* already exists */
  }
}

export async function onMenuClicked(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (info.menuItemId !== MENU_ID) return;

  const [capture, allowlist] = await Promise.all([getCapture(), getAllowlist()]);
  // THE CHOKE POINT. A paused extension, or a domain that is not on the list,
  // stops here — with no badge flash, so an unlisted site gives no signal at all.
  if (!shouldCapture(tab?.url, { enabled: capture.enabled, rules: allowlist.rules })) return;

  const text = (info.selectionText ?? '').trim();
  if (!text) return;

  const pairing = await getPairing();
  const id = crypto.randomUUID();
  await appendActivity({
    id,
    url: tab?.url ?? '',
    title: tab?.title ?? '',
    text,
    delivery: 'pending',
  });

  if (!pairing) {
    await markDelivery(id, 'failed');
    await flashCaptured(false);
    return;
  }

  try {
    await postClip(pairing.port, pairing.token, {
      kind: 'selection',
      text,
      url: tab?.url,
      title: tab?.title,
      capturedAt: new Date().toISOString(),
    });
    await markDelivery(id, 'delivered');
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
