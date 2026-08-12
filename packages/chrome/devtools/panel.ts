// The Brain panel document (item 3: count + search, updating live; item 5: the
// Ask tab — the same retrieval rendered conversationally).
//
// A devtools panel lives as long as devtools is open, so unlike the service
// worker this document MAY hold module state (same as popup/main.ts). All HTTP
// goes through the service worker via messages — the pairing token never
// enters this realm, and this document makes zero network requests of its own.

import { PANEL_POLL_MS, SEARCH_DEBOUNCE_MS } from '../src/protocol.js';
import type { NodesResponse, PanelToSw, SwToPanel } from '../src/protocol.js';
import { paintAnswer, paintHeader, paintResults, switchTab } from './panelPaint.js';

let latestNodes: NodesResponse | null = null;
let lastUpdatedAt: string | null = null;
let currentQuery = '';
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function send(msg: PanelToSw): Promise<SwToPanel> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (reply: SwToPanel) => {
      if (chrome.runtime.lastError) {
        resolve({ type: 'error', message: chrome.runtime.lastError.message ?? 'no response' });
        return;
      }
      resolve(reply);
    });
  });
}

async function refreshNodes(): Promise<void> {
  const reply = await send({ type: 'getNodes' });
  if (reply.type !== 'nodes') {
    paintHeader(latestNodes, false);
    return;
  }
  latestNodes = reply.data;
  paintHeader(latestNodes, true);
  if (!currentQuery) {
    paintResults(latestNodes.recent, latestNodes.recent.length ? 'Recently updated' : '');
  } else if (latestNodes.updatedAt !== lastUpdatedAt) {
    // Nodes changed while a search is showing — re-run it so RESULTS are live,
    // not just the count (the item-3 acceptance criterion).
    await runSearch(currentQuery);
  }
  lastUpdatedAt = latestNodes.updatedAt;
}

async function runSearch(q: string): Promise<void> {
  const reply = await send({ type: 'searchBrain', q, limit: 25 });
  if (reply.type !== 'search') return;
  if (reply.data.q !== currentQuery.slice(0, 256)) return; // a stale response lost the race
  paintResults(reply.data.hits, reply.data.count ? `${reply.data.count} match${reply.data.count === 1 ? '' : 'es'}` : 'No matches');
}

function wire(): void {
  $('tab-search').addEventListener('click', () => switchTab('search'));
  $('tab-ask').addEventListener('click', () => switchTab('ask'));

  $('q').addEventListener('input', () => {
    currentQuery = ($('q') as HTMLInputElement).value.trim();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!currentQuery) {
        if (latestNodes) paintResults(latestNodes.recent, latestNodes.recent.length ? 'Recently updated' : '');
        return;
      }
      void runSearch(currentQuery);
    }, SEARCH_DEBOUNCE_MS);
  });

  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('ask-input') as HTMLInputElement;
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    void send({ type: 'searchBrain', q, limit: 8 }).then((reply) => {
      if (reply.type === 'search') paintAnswer(q, reply.data);
    });
  });
}

async function boot(): Promise<void> {
  wire();
  // One forced probe so the badge/health agree with what the panel shows, then
  // the poll keeps everything current while the panel is visible. Devtools
  // documents do not die like MV3 workers — a plain interval is correct here.
  void send({ type: 'probeNow' });
  await refreshNodes();
  setInterval(() => {
    if (!document.hidden) void refreshNodes();
  }, PANEL_POLL_MS);
}

void boot();
