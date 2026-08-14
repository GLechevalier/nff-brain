import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredWorkflow } from '../src/schema.js';
import { WORKFLOWS_MAX } from '../src/schema.js';

// storage.ts (chrome.storage) and client.ts (fetch to the paired server) are
// the two impure seams; both are faked. The cap/eviction/custody rules run real.

vi.mock('../src/storage.js', () => {
  let store: { byId: Record<string, StoredWorkflow> } = { byId: {} };
  return {
    getWorkflowStore: vi.fn(async () => JSON.parse(JSON.stringify(store))),
    setWorkflowStore: vi.fn(async (s: { byId: Record<string, StoredWorkflow> }) => {
      store = s;
    }),
    __reset: () => {
      store = { byId: {} };
    },
  };
});
vi.mock('../src/client.js', () => ({
  getWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
}));

import * as storageMock from '../src/storage.js';
import { getWorkflow as fetchWorkflow, getWorkflows as fetchWorkflows } from '../src/client.js';
import { getLocalWorkflow, listLocalWorkflows, syncWorkflowsFromServer, upsertWorkflow } from '../src/workflowStore.js';

const SPEC = {
  v: 1 as const,
  site: 'example.com',
  intent: 'do the thing',
  params: [],
  steps: [{ id: 'step-1', intent: 'click go' }],
  successCriteria: 'done',
  sourceTraceId: 'tr',
  recordedAt: new Date(0).toISOString(),
};

function wf(id: string, source: 'server' | 'local', savedAt = new Date().toISOString()): StoredWorkflow {
  return { id, title: id, intent: 'do the thing', site: 'example.com', params: [], spec: SPEC, savedAt, source };
}

describe('workflowStore', () => {
  beforeEach(() => {
    (storageMock as unknown as { __reset: () => void }).__reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('upsert + get + list round-trip, newest first, summary shape', async () => {
    await upsertWorkflow(wf('a', 'local', '2026-01-01T00:00:00Z'));
    await upsertWorkflow(wf('b', 'server', '2026-02-01T00:00:00Z'));
    expect((await getLocalWorkflow('a'))?.spec).toEqual(SPEC);
    const list = await listLocalWorkflows();
    expect(list.map((w) => w.id)).toEqual(['b', 'a']);
    expect(list[0]).toEqual({ id: 'b', title: 'b', intent: 'do the thing', site: 'example.com', params: [] });
  });

  it('at the cap, evicts the OLDEST server import to admit a new entry', async () => {
    for (let i = 0; i < WORKFLOWS_MAX; i++) {
      await upsertWorkflow(wf(`s${i}`, 'server', `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`));
    }
    const res = await upsertWorkflow(wf('new-local', 'local'));
    expect(res.ok).toBe(true);
    expect(await getLocalWorkflow('s0')).toBeNull(); // oldest server entry gone
    expect(await getLocalWorkflow('new-local')).not.toBeNull();
  });

  it('REFUSES a local save at a cap of only local entries — never silent eviction', async () => {
    for (let i = 0; i < WORKFLOWS_MAX; i++) await upsertWorkflow(wf(`l${i}`, 'local'));
    const res = await upsertWorkflow(wf('one-more', 'local'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('full');
    expect(await getLocalWorkflow('l0')).not.toBeNull();
  });

  it('quietly skips a server import at a cap of only local entries', async () => {
    for (let i = 0; i < WORKFLOWS_MAX; i++) await upsertWorkflow(wf(`l${i}`, 'local'));
    const res = await upsertWorkflow(wf('srv', 'server'));
    expect(res.ok).toBe(true);
    expect(await getLocalWorkflow('srv')).toBeNull();
  });

  it('updating an existing id never triggers eviction', async () => {
    for (let i = 0; i < WORKFLOWS_MAX; i++) await upsertWorkflow(wf(`l${i}`, 'local'));
    const res = await upsertWorkflow(wf('l3', 'local'));
    expect(res.ok).toBe(true);
    expect(await listLocalWorkflows()).toHaveLength(WORKFLOWS_MAX);
  });

  it('sync imports only MISSING ids and swallows per-item failures', async () => {
    await upsertWorkflow(wf('have', 'server'));
    vi.mocked(fetchWorkflows).mockResolvedValue({
      ok: true,
      items: [
        { id: 'have', title: 'have', intent: 'x', site: 's', params: [] },
        { id: 'want', title: 'want', intent: 'x', site: 's', params: [] },
        { id: 'broken', title: 'broken', intent: 'x', site: 's', params: [] },
      ],
    });
    vi.mocked(fetchWorkflow).mockImplementation(async (_p, _t, id) => {
      if (id === 'broken') throw new Error('boom');
      return { ok: true, id, title: id, spec: SPEC };
    });

    await syncWorkflowsFromServer({ port: 7373, token: 't', clientId: 'c', serverId: 's', pairedAt: '' });
    expect(vi.mocked(fetchWorkflow)).toHaveBeenCalledTimes(2); // 'have' skipped
    expect(await getLocalWorkflow('want')).not.toBeNull();
    expect(await getLocalWorkflow('broken')).toBeNull();
  });

  it('sync with an unreachable server leaves the store untouched', async () => {
    await upsertWorkflow(wf('keep', 'local'));
    vi.mocked(fetchWorkflows).mockRejectedValue(new Error('down'));
    await syncWorkflowsFromServer({ port: 7373, token: 't', clientId: 'c', serverId: 's', pairedAt: '' });
    expect(await listLocalWorkflows()).toHaveLength(1);
  });
});
