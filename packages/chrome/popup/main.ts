// Popup entry: wires listeners, owns no logic.
//
// Freshness comes from two channels, and both are needed:
//   PULL, on open  — paint last-known state immediately (never a spinner), then
//                    force one probe, because a popup being opened is the
//                    strongest possible signal that the user wants current data.
//   PUSH, while open — chrome.storage.onChanged. When the probe lands, the
//                    service worker writes nb.health and we repaint. No polling
//                    from the popup and no callback plumbing.

import { DEFAULT_PORT } from '../src/protocol.js';
import type { PopupToSw, PublicState, SwToPopup } from '../src/protocol.js';
import { adapterById } from '../src/recorderRegistry.js';
import { hideClearConfirm, paint, paintClearConfirm, showFieldError } from './paint.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let latest: PublicState | null = null;
let currentHost: string | null = null;

function send(msg: PopupToSw): Promise<SwToPopup> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToPopup) => {
      // Closing the popup mid-probe leaves lastError set ("message port closed
      // before a response was received"). Harmless, but reading it keeps the
      // console clean — an unexplained error there looks like a bug in review.
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

function render(state: PublicState): void {
  latest = state;
  paint(state, {
    currentHost,
    onRemoveRule: (host) => void dispatch({ type: 'removeRule', host }),
    onToggleRecorder: (id, enable) => void toggleRecorder(id, enable),
  });
}

/**
 * Enable runs HERE, not in the worker: chrome.permissions.request needs a user
 * gesture, and the popup click is that gesture. Only a granted permission
 * flips the recorder on; a denied prompt leaves everything off.
 */
async function toggleRecorder(id: string, enable: boolean): Promise<void> {
  if (!enable) {
    await dispatch({ type: 'setRecorderEnabled', id, enabled: false }, 'recorder-error');
    return;
  }
  const adapter = adapterById(id);
  if (!adapter) return;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: adapter.originPatterns });
  } catch {
    granted = false;
  }
  if (!granted) {
    showFieldError('recorder-error', `Chrome permission for ${adapter.hosts.join(', ')} was not granted — the recorder stays off.`);
    return;
  }
  await dispatch({ type: 'setRecorderEnabled', id, enabled: true }, 'recorder-error');
}

async function dispatch(msg: PopupToSw, errorField?: string): Promise<boolean> {
  const reply = await send(msg);
  if (reply.type === 'error') {
    if (errorField) showFieldError(errorField, reply.message);
    return false;
  }
  if (errorField) showFieldError(errorField, null);
  // Data replies (nodes/search) exist for the DevTools panel; the popup only
  // ever sends state-returning messages, so anything else is ignored here.
  if (reply.type === 'state') render(reply.state);
  return true;
}

async function resolveCurrentHost(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // activeTab grants url access only for the tab the action was clicked on,
    // and never on chrome:// or Web Store pages — hence the graceful null.
    currentHost = tab?.url ? new URL(tab.url).hostname : null;
    if (currentHost && !/^https?:$/.test(new URL(tab!.url!).protocol)) currentHost = null;
  } catch {
    currentHost = null;
  }
}

function wire(): void {
  $('retry').addEventListener('click', () => void dispatch({ type: 'probeNow' }));

  $('connect').addEventListener('click', () => {
    const port = Number(($('port') as HTMLInputElement).value || DEFAULT_PORT);
    const code = ($('code') as HTMLInputElement).value;
    void dispatch({ type: 'pair', port, code }, 'pair-error');
  });
  $('code').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') $('connect').click();
  });

  $('capture-toggle').addEventListener('click', () => {
    void dispatch({ type: 'setCaptureEnabled', enabled: !(latest?.capture.enabled ?? false) });
  });

  const addRule = () => {
    const input = $('rule-input') as HTMLInputElement;
    void dispatch({ type: 'addRule', input: input.value }, 'rule-error').then((ok) => {
      if (ok) input.value = '';
    });
  };
  $('rule-add').addEventListener('click', addRule);
  $('rule-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addRule();
  });
  $('allow-current').addEventListener('click', () => {
    if (currentHost) void dispatch({ type: 'addRule', input: currentHost }, 'rule-error');
  });

  $('clear').addEventListener('click', () => {
    if (latest) paintClearConfirm(latest);
  });
  $('clear-no').addEventListener('click', hideClearConfirm);
  $('clear-yes').addEventListener('click', () => {
    const alsoRemoveNodes = ($('clear-nodes') as HTMLInputElement).checked;
    void dispatch({ type: 'clearActivity', alsoRemoveNodes }).then(hideClearConfirm);
  });

  // PUSH channel: any write by the service worker repaints us.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') void dispatch({ type: 'getState' });
  });
}

async function boot(): Promise<void> {
  ($('port') as HTMLInputElement).value = String(DEFAULT_PORT);
  wire();
  await resolveCurrentHost();
  await dispatch({ type: 'getState' }); // paint instantly from storage
  void dispatch({ type: 'probeNow' }); // then refresh in the background
}

void boot();
