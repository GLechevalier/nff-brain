// The local workflow store (nb.workflows): replayable specs kept in the
// browser so BYOK mode lists and replays workflows with no server. Paired
// mode still treats the server as the source of record — this store is a
// read-through cache of it (one-way import via syncWorkflowsFromServer) plus
// the home of browser-distilled 'local' workflows that may exist nowhere else.

import { WORKFLOWS_MAX } from './schema.js';
import type { Pairing, StoredWorkflow } from './schema.js';
import { getWorkflowStore, setWorkflowStore } from './storage.js';
import { getWorkflow as fetchWorkflowFromServer, getWorkflows as fetchWorkflowsFromServer } from './client.js';
import type { WorkflowSummary } from './protocol.js';

function toSummary(w: StoredWorkflow): WorkflowSummary {
  return { id: w.id, title: w.title, intent: w.intent, site: w.site, params: w.params };
}

/** Newest first — the same order the server list renders in. */
export async function listLocalWorkflows(): Promise<WorkflowSummary[]> {
  const store = await getWorkflowStore();
  return Object.values(store.byId)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
    .map(toSummary);
}

export async function getLocalWorkflow(id: string): Promise<StoredWorkflow | null> {
  const store = await getWorkflowStore();
  return store.byId[id] ?? null;
}

export interface UpsertResult {
  ok: boolean;
  /** Short and user-showable — only set when a 'local' save was refused at the cap. */
  error?: string;
}

/**
 * Insert or update one workflow. At the cap, the oldest 'server' import is
 * evicted to make room (the server still has it); a 'local' workflow is NEVER
 * evicted silently — if only local entries remain, a new 'local' save is
 * refused loudly and a new 'server' import is skipped quietly (it still
 * exists server-side, the cache just stays full).
 */
export async function upsertWorkflow(w: StoredWorkflow): Promise<UpsertResult> {
  const store = await getWorkflowStore();
  const isUpdate = w.id in store.byId;
  if (!isUpdate && Object.keys(store.byId).length >= WORKFLOWS_MAX) {
    const evictable = Object.values(store.byId)
      .filter((e) => e.source === 'server')
      .sort((a, b) => (a.savedAt < b.savedAt ? -1 : 1));
    if (evictable.length > 0) {
      delete store.byId[evictable[0]!.id];
    } else if (w.source === 'local') {
      return { ok: false, error: `workflow store is full (${WORKFLOWS_MAX}) — delete some workflows first` };
    } else {
      return { ok: true }; // server import skipped; the server remains the record
    }
  }
  store.byId[w.id] = w;
  await setWorkflowStore(store);
  return { ok: true };
}

/**
 * One-way opportunistic import: fetch the server's summary list and pull the
 * full spec for any id missing locally. Fire-and-forget — every failure is
 * swallowed (the next call retries), and nothing local is ever deleted or
 * overwritten by it, so a flaky server can't hollow out the cache.
 */
export async function syncWorkflowsFromServer(pairing: Pairing): Promise<void> {
  try {
    const { items } = await fetchWorkflowsFromServer(pairing.port, pairing.token);
    const store = await getWorkflowStore();
    for (const item of items) {
      if (item.id in store.byId) continue;
      try {
        const full = await fetchWorkflowFromServer(pairing.port, pairing.token, item.id);
        await upsertWorkflow({
          id: item.id,
          title: full.title || item.title,
          intent: item.intent,
          site: item.site,
          params: item.params,
          spec: full.spec,
          savedAt: new Date().toISOString(),
          source: 'server',
        });
      } catch {
        // One workflow failing to import must not abort the rest.
      }
    }
  } catch {
    // Server unreachable — the local store simply stays as it was.
  }
}
