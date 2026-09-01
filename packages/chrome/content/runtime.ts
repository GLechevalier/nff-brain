// Shared content-script runtime. Deliberately tiny, and deliberately blind:
// a content script never sees the pairing token, never fetches, and never
// touches chrome.storage — it observes the user's own actions and messages
// the service worker, which owns every real decision (gate, dedupe, delivery).
//
// The per-page-load Set is the FIRST dedupe layer only; losing it on
// navigation is fine because the worker's persistent ring is authoritative.
// (Module state is safe here: a content script lives exactly as long as its
// page — the MV3 worker-death rule does not apply to this file.)

import type { RecorderEventMsg } from '../src/recorderTypes.js';

const emittedThisPage = new Set<string>();

export function emit(msg: Omit<RecorderEventMsg, 'type' | 'at'>): void {
  if (emittedThisPage.has(msg.key)) return;
  emittedThisPage.add(msg.key);
  try {
    chrome.runtime.sendMessage(
      { type: 'recorderEvent', at: new Date().toISOString(), ...msg },
      () => void chrome.runtime.lastError, // worker asleep/gone — reading clears the warning
    );
  } catch {
    /* extension reloaded under the page — nothing to do */
  }
}

/**
 * The task recorder's wire (record-and-automate): a raw, UN-deduped event for a
 * recording in progress. Unlike emit(), order and repetition matter here — the
 * distiller needs the full sequence — so there is no per-page dedupe. Still the
 * same blind posture: no token, no fetch, no storage; the SW validates, stamps
 * the real url from sender.tab.url, gates, and rings it. `raw` is untrusted by
 * construction and clamped SW-side (normalizeTraceEvent).
 */
export function emitTrace(raw: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage({ type: 'traceEvent', event: raw }, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloaded under the page — nothing to do */
  }
}

/**
 * The LinkedIn network-tap wire: the MAIN-world tap (rec-linkedin-net.js) can't
 * message the SW itself (it holds no chrome.*), so it window.postMessage's to
 * the isolated content script, which forwards the raw summary here. Same blind
 * posture — no token, no fetch, no storage; the SW (onLinkedinNet) classifies,
 * gates on sender.tab.url + the recorder toggle, and owns storage/CRM. `payload`
 * is untrusted by construction and re-validated SW-side.
 */
export function emitNet(payload: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage({ type: 'linkedinNet', payload }, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloaded under the page — nothing to do */
  }
}

/** First non-empty line of a textarea-ish value, for comment titles. */
export function firstLine(text: string, max = 120): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  ).slice(0, max);
}

/** Local day bucket for fallback dedupe keys. */
export function dayBucket(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
