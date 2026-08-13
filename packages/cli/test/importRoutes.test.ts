import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CLIP_NODES, formatPairingCode, loadBrain, readClipMap } from '@nff-brain/core';
import type { BrainNode } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// POST /v1/import — the standalone→paired migration route. Same raw node:http
// harness as serveHttp.test.ts (fetch forbids the headers these tests need).

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

interface Reply {
  status: number;
  body: string;
  json: <T = Record<string, unknown>>() => T;
}

function request(
  port: number,
  opts: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body || '{}') }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

let dir: string;
let server: BrainServer;
let port: number;
let globalBrain: string;
let configFile: string;

function writeBrain(file: string, nodes: Array<Partial<BrainNode> & { id: string }>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        title: n.id,
        category: 'strategy',
        content: 'x',
        color: '#fff',
        x: 0,
        y: 0,
        size: 16,
        origin: 'agent',
        lastUpdated: new Date().toISOString(),
        recallCount: 0,
        ...n,
      })),
      edges: [],
    }),
  );
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-import-'));
  globalBrain = path.join(dir, 'home', '.nff-brain', 'brain.json');
  configFile = path.join(dir, 'home', '.nff-brain', 'serve.json');
  writeBrain(path.join(dir, 'ws', '.nff-brain', 'brain.json'), []);
  writeBrain(globalBrain, [{ id: 'agent-node', origin: 'agent' }]);

  server = await startBrainServer({
    port: 0,
    workspaceRoot: path.join(dir, 'ws'),
    projectBrainPath: path.join(dir, 'ws', '.nff-brain', 'brain.json'),
    globalBrainPath: globalBrain,
    allowOrigins: [],
    cliVersion: '0.0.0-test',
    configFile,
  });
  port = server.port;
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function pair(): Promise<string> {
  const code = server.state.openPairing();
  const res = await request(port, {
    path: '/v1/pair',
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ code: formatPairingCode(code), client: { name: 'Chrome extension' } }),
  });
  expect(res.status).toBe(200);
  return res.json<{ token: string }>().token;
}

function auth(token: string) {
  return { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function postImport(token: string, payload: unknown): Promise<Reply> {
  return request(port, {
    path: '/v1/import',
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

const NODE = {
  id: 'esp32-cors-gotcha',
  title: 'CORS preflight before auth',
  category: 'rules',
  content: 'Answer the preflight before auth or every extension call fails opaquely.',
  sourceUrl: 'https://example.com/post',
  x: 10,
  y: 20,
  size: 16,
  color: '#00ffcc',
};

describe('POST /v1/import — gates', () => {
  it('rejects an unpaired origin at the Origin gate (before auth)', async () => {
    const res = await request(port, {
      path: '/v1/import',
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [NODE] }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a paired origin without a bearer token', async () => {
    await pair();
    const res = await request(port, {
      path: '/v1/import',
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [NODE] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an over-cap body with 413', async () => {
    const token = await pair();
    const huge = { nodes: [{ ...NODE, content: 'y'.repeat(1024 * 1024 + 100) }] };
    // The server destroys the socket past the cap, so the client may see a
    // reset instead of the 413 — same accommodation as serveHttp.test.ts.
    const res = await postImport(token, huge).catch(() => ({ status: 413 }) as Reply);
    expect(res.status).toBe(413);
  });
});

describe('POST /v1/import — semantics', () => {
  it('imports nodes into the GLOBAL brain with origin forced to clip', async () => {
    const token = await pair();
    const res = await postImport(token, {
      nodes: [{ ...NODE, origin: 'agent' }, { ...NODE, id: 'second', title: 'Second', category: 'core' }],
      edges: [{ from: 'esp32-cors-gotcha', to: 'second', strength: 0.7 }],
    });
    expect(res.status).toBe(201);
    expect(res.json<{ imported: number }>().imported).toBe(2);

    const brain = loadBrain(globalBrain)!;
    const imported = brain.nodes.filter((n) => n.id !== 'agent-node');
    expect(imported).toHaveLength(2);
    for (const n of imported) expect(n.origin).toBe('clip');
    // 'core' category is downgraded — a clip can never become a hub node
    expect(brain.nodes.find((n) => n.id === 'second')!.category).toBe('strategy');
    expect(brain.edges).toEqual([{ from: 'esp32-cors-gotcha', to: 'second', strength: 0.7 }]);
    expect(brain.nodes.find((n) => n.id === 'esp32-cors-gotcha')!.sourceUrl).toBe('https://example.com/post');
  });

  it('re-mints ids colliding with non-clip nodes and reports the remap', async () => {
    const token = await pair();
    const res = await postImport(token, { nodes: [{ ...NODE, id: 'agent-node' }] });
    expect(res.status).toBe(201);
    const body = res.json<{ remapped: Array<{ from: string; to: string }> }>();
    expect(body.remapped).toEqual([{ from: 'agent-node', to: 'agent-node-2' }]);

    const brain = loadBrain(globalBrain)!;
    expect(brain.nodes.find((n) => n.id === 'agent-node')!.origin).toBe('agent'); // untouched
    expect(brain.nodes.find((n) => n.id === 'agent-node-2')!.origin).toBe('clip');
  });

  it('is idempotent: re-importing the same payload changes nothing', async () => {
    const token = await pair();
    await postImport(token, { nodes: [{ ...NODE, id: 'agent-node' }, NODE] });
    const before = loadBrain(globalBrain)!;
    const res = await postImport(token, { nodes: [{ ...NODE, id: 'agent-node' }, NODE] });
    expect(res.status).toBe(201);
    const after = loadBrain(globalBrain)!;
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
    // deterministic remap: same collision maps to the same suffix on retry
    expect(res.json<{ remapped: unknown }>().remapped).toEqual([{ from: 'agent-node', to: 'agent-node-2' }]);
  });

  it('drops edges that reference anything outside the imported set', async () => {
    const token = await pair();
    await postImport(token, {
      nodes: [NODE],
      edges: [{ from: 'esp32-cors-gotcha', to: 'agent-node', strength: 0.9 }],
    });
    expect(loadBrain(globalBrain)!.edges).toEqual([]);
  });

  it('attributes every imported node to the client so retract works post-migration', async () => {
    const token = await pair();
    await postImport(token, {
      nodes: [NODE, { ...NODE, id: 'uncovered', title: 'Uncovered' }],
      map: [{ clipId: 'clp_abc', nodeIds: ['esp32-cors-gotcha'] }],
    });

    const entries = readClipMap(globalBrain);
    expect(entries.map((e) => e.clipId).sort()).toEqual(['clp_abc', 'imp_uncovered']);
    for (const e of entries) expect(e.clientId).toBeTruthy();

    const retract = await request(port, {
      path: '/v1/retract',
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ nodeIds: ['esp32-cors-gotcha', 'uncovered', 'agent-node'] }),
    });
    expect(retract.json<{ removed: string[] }>().removed.sort()).toEqual(['esp32-cors-gotcha', 'uncovered']);
    expect(loadBrain(globalBrain)!.nodes.map((n) => n.id)).toEqual(['agent-node']);
  });

  it('survives a full-size standalone brain: MAX_CLIP_NODES imports intact', async () => {
    const token = await pair();
    const nodes = Array.from({ length: MAX_CLIP_NODES }, (_, i) => ({
      ...NODE,
      id: `clip-${i}`,
      title: `Clip ${i}`,
    }));
    const res = await postImport(token, { nodes });
    expect(res.status).toBe(201);
    const body = res.json<{ imported: number; evicted: string[] }>();
    expect(body.imported).toBe(MAX_CLIP_NODES);
    expect(body.evicted).toEqual([]);
  });

  it('ignores junk nodes and empty payloads gracefully', async () => {
    const token = await pair();
    const res = await postImport(token, {
      nodes: [{ id: 'no-title', content: 'x' }, { title: 'no content' }, 42, null],
    });
    expect(res.status).toBe(201);
    expect(res.json<{ imported: number }>().imported).toBe(0);
    expect(loadBrain(globalBrain)!.nodes.map((n) => n.id)).toEqual(['agent-node']);

    const empty = await postImport(token, { nodes: [] });
    expect(empty.status).toBe(200);
    expect(empty.json<{ imported: number }>().imported).toBe(0);
  });
});
