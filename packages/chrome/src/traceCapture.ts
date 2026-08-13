// SW side of the task recorder (record-and-automate). Starts/stops a per-tab
// recording, dynamically (un)registers the traceRecorder content script for the
// recording origin, and validates + rings every event the script streams in.
//
// Every event is UNTRUSTED: the SW clamps it (normalizeTraceEvent), STAMPS the
// real url from sender.tab.url (a content script can never spoof which page it
// acted on), and only accepts it from the tab the recording is bound to.
// Appends are serialized on one promise chain — events arrive as separate
// runtime messages and would otherwise interleave and drop.
//
// The append chain is the FOURTH documented module-level variable in this
// codebase (after connection.ts, brainStore.ts, actStore.ts) and is harmless to
// lose for the same reason: it only orders writes within one worker lifetime,
// which is exactly a module variable's lifespan. bundlePurity pins it.

import { MAX_TRACE_BYTES, MAX_TRACE_EVENTS, newTraceId, normalizeTraceEvent, traceByteSize } from '@nff-brain/core/trace';
import type { TraceEvent, TraceRecord } from '@nff-brain/core/trace';
import type { TraceActiveState } from './schema.js';
import { getTraceActive, setTraceActive, setTracePending } from './storage.js';

const TRACE_SCRIPT_ID = 'nff.trace';
const TRACE_SCRIPT_FILE = 'rec-trace.js';

let appendChain: Promise<unknown> = Promise.resolve(); // harmless to lose — see header

function runExclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = appendChain.then(job, job);
  appendChain = next.catch(() => undefined);
  return next;
}

function originPattern(url: string): string | null {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

export interface StartTraceResult {
  ok: boolean;
  error?: string;
}

/**
 * Begin recording `tabId`. Requires the origin's host permission to already be
 * granted (the same "Allow this site" grant the recorder uses) — that is what
 * lets us inject at all, and it keeps recording inside the user's allowlist. No
 * new manifest permission.
 */
export async function startTraceRecording(tabId: number): Promise<StartTraceResult> {
  const existing = await getTraceActive();
  if (existing?.recording) return { ok: false, error: 'a recording is already in progress' };

  let url: string | undefined;
  let title: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
    title = tab.title;
  } catch {
    return { ok: false, error: 'that tab is no longer open' };
  }
  const pattern = url ? originPattern(url) : null;
  if (!pattern) return { ok: false, error: 'cannot record this page' };

  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (!granted) return { ok: false, error: 'allow this site first (use "Allow this site" in the popup), then record' };

  // Register for future navigations within the tab, and inject now so recording
  // starts without a reload.
  try {
    const already = await chrome.scripting.getRegisteredContentScripts({ ids: [TRACE_SCRIPT_ID] });
    if (already.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: TRACE_SCRIPT_ID,
          js: [TRACE_SCRIPT_FILE],
          matches: [pattern],
          runAt: 'document_start',
          persistAcrossSessions: false,
        },
      ]);
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: [TRACE_SCRIPT_FILE] });
  } catch (err) {
    await unregister();
    return { ok: false, error: err instanceof Error ? err.message : 'could not start recording on this page' };
  }

  const now = new Date().toISOString();
  const state: TraceActiveState = {
    recording: true,
    id: newTraceId(Date.now(), Math.random().toString(16).slice(2, 8)),
    tabId,
    startedAt: now,
    startUrl: url!,
    title,
    events: [],
    bytes: 2,
  };
  await setTraceActive(state);
  return { ok: true };
}

async function unregister(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [TRACE_SCRIPT_ID] });
  } catch {
    /* not registered — fine */
  }
}

/**
 * Finish the recording: unregister the script, freeze the accumulated events
 * into a TraceRecord, and hand it to the pending slot for distillation. Returns
 * the finished record (null if nothing was recording).
 */
export async function stopTraceRecording(): Promise<TraceRecord | null> {
  return runExclusive(async () => {
    const active = await getTraceActive();
    await unregister();
    if (!active) return null;
    const record: TraceRecord = {
      v: 1,
      id: active.id,
      startedAt: active.startedAt,
      endedAt: new Date().toISOString(),
      startUrl: active.startUrl,
      title: active.title,
      events: active.events,
      source: 'chrome',
    };
    await setTracePending(record);
    await setTraceActive(null);
    return record;
  });
}

/** Discard an in-progress recording without saving it. */
export async function cancelTraceRecording(): Promise<void> {
  await unregister();
  await setTraceActive(null);
}

/**
 * Handle one streamed event. Validates, stamps the trusted url, appends, and
 * auto-stops on a cap. Silently ignores anything from the wrong tab or when no
 * recording is active — so removing the recording (or the tab closing) silences
 * it with no extra code.
 */
export async function onTraceEvent(rawEvent: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  await runExclusive(async () => {
    const active = await getTraceActive();
    if (!active || !active.recording) return;
    if (sender.tab?.id !== active.tabId) return;
    const ev = normalizeTraceEvent(rawEvent);
    if (!ev) return;
    ev.url = sender.tab?.url ?? active.startUrl; // trusted url, never the script's claim

    const events: TraceEvent[] = [...active.events, ev];
    const bytes = traceByteSize(events);
    const overCap = events.length >= MAX_TRACE_EVENTS || bytes >= MAX_TRACE_BYTES;

    await setTraceActive({ ...active, events, bytes, recording: !overCap });
    if (overCap) {
      // Freeze what we have rather than drop it — same as an explicit stop.
      await unregister();
      await setTracePending({
        v: 1,
        id: active.id,
        startedAt: active.startedAt,
        endedAt: new Date().toISOString(),
        startUrl: active.startUrl,
        title: active.title,
        events,
        source: 'chrome',
      });
      await setTraceActive(null);
    }
  });
}
