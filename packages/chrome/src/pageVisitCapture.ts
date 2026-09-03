// Passive page-visit capture: on an allowlisted site, read the core text of a
// page the user navigates to and queue it for the standalone drain to distill
// into a pagevisit-origin brain node.
//
// The THIRD registered caller of shouldCapture() (alongside capture.ts and
// recorder.ts — see bundlePurity.test.ts's pinned list). This is deliberately
// NOT the same tap as activity.ts's logVisit(): that one is a local title/url
// log, gated only by nb.logVisits and explicitly "never allowlist-gated,
// never sent anywhere" — this path eventually costs an LLM call, so it must
// go through the same choke point clips do.
//
// chrome.scripting.executeScript, never chrome.debugger (CDP): attaching the
// debugger shows Chrome's "being debugged by an extension" infobar, which a
// feature that can fire on every navigation to an allowlisted site cannot
// afford. Any extraction failure — no host permission for this origin
// (declined or never requested), a restricted page, the tab already gone —
// is caught and silently no-ops: passive capture must never surface an error.

import { appendActivity, markDelivery, pushRecent, recentKey, seenRecently } from './activity.js';
import { postClip } from './client.js';
import { shouldCapture } from './gate.js';
import { resolveBrainMode } from './mode.js';
import { extractPageText, type PageExtract } from './pageExtractScript.js';
import { enqueuePageVisit } from './standaloneDrain.js';
import { PAGEVISIT_SEEN_MAX, PAGEVISIT_WINDOW_MS } from './schema.js';
import { getAllowlist, getCapture, getPageVisitSeen, getPairing, setPageVisitSeen } from './storage.js';

/** Below this, there is honestly nothing worth queuing — an empty shell, a
 *  cookie-wall page, a redirect stub. */
const MIN_TEXT_LEN = 40;

export async function capturePageVisit(
  tabId: number,
  info: { status?: string; url?: string },
  tab: { url?: string; status?: string; title?: string },
): Promise<void> {
  const url = tab.url ?? '';
  if (!/^https?:\/\//.test(url)) return;
  const loaded = info.status === 'complete' || (info.url !== undefined && tab.status === 'complete');
  if (!loaded) return;

  const [capture, allowlist] = await Promise.all([getCapture(), getAllowlist()]);
  // THE CHOKE POINT — same as capture.ts and recorder.ts. A paused extension,
  // or a domain not on the list, stops here.
  if (!shouldCapture(url, { enabled: capture.enabled, rules: allowlist.rules })) return;

  // Per-URL/24h dedupe — a page revisited later the same day should not
  // requeue and re-cost an LLM call. Content-independent (empty text arg):
  // unlike capture.ts's dedupe (same selection captured twice), a visit is
  // identified by the URL alone.
  const nowMs = Date.now();
  const key = recentKey('pagevisit', url, '');
  const seen = await getPageVisitSeen();
  if (seenRecently(seen, key, nowMs, PAGEVISIT_WINDOW_MS)) return;
  await setPageVisitSeen(pushRecent(seen, key, nowMs, PAGEVISIT_WINDOW_MS, PAGEVISIT_SEEN_MAX));

  let extract: PageExtract = { title: '', text: '' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageText });
    if (res?.result) extract = res.result as PageExtract;
  } catch {
    return;
  }
  if (extract.text.trim().length < MIN_TEXT_LEN) return;

  const title = extract.title || tab.title || '';
  const id = crypto.randomUUID();
  await appendActivity({ id, url, title, text: extract.text.slice(0, 200), delivery: 'pending' });

  // Same branch capture.ts uses: paired mode POSTs to the local server (its
  // own drain distills at the next Claude Code SessionEnd or `nff-brain
  // clips --drain` — no periodic timer, same cadence as explicit clips);
  // BYOK/unconfigured falls back to the local queue+alarm drain.
  const pairing = await getPairing();
  if (!pairing || (await resolveBrainMode()) === 'byok') {
    await enqueuePageVisit({ text: extract.text, url, title }, id);
    return;
  }

  try {
    const res = await postClip(pairing.port, pairing.token, {
      kind: 'pagevisit',
      text: extract.text,
      url,
      title,
      capturedAt: new Date().toISOString(),
    });
    await markDelivery(id, 'delivered', res.id);
  } catch {
    // Silent — passive capture never surfaces an error, same posture as the
    // local path's own failure handling.
    await markDelivery(id, 'failed');
  }
}
