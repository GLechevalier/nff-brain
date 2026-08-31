import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitBrain, loadRefs, pushBranch, saveBrain, upsertNode, type BrainNode } from '../src/index.js';

let dir: string;
let brainPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-push-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: `content of ${id}`,
    color: '#a78bfa',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
    ...extra,
  };
}

describe('pushBranch', () => {
  it('throws when the branch has no commits', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [], edges: [] });
    await expect(pushBranch(brainPath, { token: 't' })).rejects.toThrow(/no commits/);
  });

  it('posts the whole chain on the first push and records lastPushed', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    const c1 = await commitBrain(brainPath, { author: 'alice', message: 'one' });
    const brain = fs.existsSync(brainPath) ? JSON.parse(fs.readFileSync(brainPath, 'utf8')) : null;
    upsertNode(brain, node('b'));
    saveBrain(brainPath, brain);
    const c2 = await commitBrain(brainPath, { author: 'alice', message: 'two' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pushed: 2, merged: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pushBranch(brainPath, { token: 'secret', url: 'https://example.test/push' });
    expect(result).toEqual({ pushed: 2, merged: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/push');
    expect(init.headers['x-brain-sync-token']).toBe('secret');
    const body = JSON.parse(init.body);
    expect(body.commits.map((c: { id: string }) => c.id)).toEqual([c1!.id, c2!.id]);

    expect(loadRefs(brainPath).lastPushed).toEqual({ main: c2!.id });
  });

  it('only sends commits after lastPushed on a second push', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    const c1 = await commitBrain(brainPath, { author: 'alice', message: 'one' });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pushed: 1, merged: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await pushBranch(brainPath, { token: 't' });
    expect(loadRefs(brainPath).lastPushed).toEqual({ main: c1!.id });

    const brain = JSON.parse(fs.readFileSync(brainPath, 'utf8'));
    upsertNode(brain, node('b'));
    saveBrain(brainPath, brain);
    const c2 = await commitBrain(brainPath, { author: 'alice', message: 'two' });

    await pushBranch(brainPath, { token: 't' });
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.commits.map((c: { id: string }) => c.id)).toEqual([c2!.id]);
  });

  it('is a no-op when nothing changed since the last push', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    await commitBrain(brainPath, { author: 'alice' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pushed: 1, merged: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await pushBranch(brainPath, { token: 't' });

    const result = await pushBranch(brainPath, { token: 't' });
    expect(result).toEqual({ pushed: 0, merged: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call never hit the network
  });

  it('throws with the HTTP status on a failed push', async () => {
    saveBrain(brainPath, { version: 1 as const, updatedAt: '', nodes: [node('a')], edges: [] });
    await commitBrain(brainPath, { author: 'alice' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(pushBranch(brainPath, { token: 'bad' })).rejects.toThrow(/401/);
  });
});
