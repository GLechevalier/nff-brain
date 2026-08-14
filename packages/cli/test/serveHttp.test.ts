import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendClipMap,
  clipMapPath,
  clipQueueStats,
  compactClipMap,
  formatPairingCode,
  loadServeConfig,
  readClipMap,
  saveServeConfig,
} from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// Raw node:http, deliberately NOT fetch: undici treats Host as a forbidden
// header, so the DNS-rebinding test below is simply unwritable with fetch.

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER_ORIGIN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
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
        // Default Host, overridable — that override is the point of this helper.
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body || '{}'),
          }),
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
let projectBrain: string;
let globalBrain: string;
let configFile: string;

function writeBrain(file: string, nodeIds: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      nodes: nodeIds.map((id) => ({ id, title: id })),
      edges: [],
    }),
  );
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-serve-http-'));
  projectBrain = path.join(dir, 'ws', '.nff-brain', 'brain.json');
  globalBrain = path.join(dir, 'home', '.nff-brain', 'brain.json');
  configFile = path.join(dir, 'home', '.nff-brain', 'serve.json');
  writeBrain(projectBrain, ['p1', 'p2', 'shared']);
  writeBrain(globalBrain, ['g1', 'shared']);

  server = await startBrainServer({
    port: 0,
    workspaceRoot: path.join(dir, 'ws'),
    projectBrainPath: projectBrain,
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

/** Open a window, pair, and return the client bearer token. */
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

function auth(token: string, extra: Record<string, string> = {}) {
  return { origin: ORIGIN, authorization: `Bearer ${token}`, ...extra };
}

describe('GET /v1/hello', () => {
  it('answers without auth and leaks no path, count or token', async () => {
    const res = await request(port, { path: '/v1/hello' });
    expect(res.status).toBe(200);
    const body = res.json<{ name: string; protocol: number; paired: boolean }>();
    expect(body.name).toBe('nff-brain');
    expect(body.protocol).toBe(1);
    expect(body.paired).toBe(false);
    expect(res.body).not.toContain(dir);
    expect(res.body).not.toContain('nodes');
    expect(res.body).not.toContain(loadServeConfig(configFile)!.adminToken);
  });

  it('proves it knows a client token without either side sending one', async () => {
    const token = await pair();
    const clientId = loadServeConfig(configFile)!.clients[0]!.id;
    const res = await request(port, { path: `/v1/hello?nonce=deadbeef&client=${clientId}`, headers: { origin: ORIGIN } });
    expect(res.json<{ proof: string }>().proof).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).not.toContain(token);
  });
});

describe('CORS preflight', () => {
  it('succeeds with NO Authorization header — the gate-6 regression guard', async () => {
    // A preflight never carries Authorization. Running auth before the OPTIONS
    // branch makes every extension call fail as an opaque Chrome CORS error
    // with nothing pointing at authentication.
    const token = await pair();
    expect(token).toBeTruthy();
    const res = await request(port, {
      path: '/v1/status',
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers.vary).toBe('Origin');
  });

  it('never answers with a wildcard origin', async () => {
    await pair();
    const res = await request(port, { path: '/v1/status', method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('mirrors a Private Network Access preflight', async () => {
    const res = await request(port, {
      path: '/v1/pair',
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('omits the private-network header when the preflight did not ask', async () => {
    const res = await request(port, { path: '/v1/pair', method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(res.headers['access-control-allow-private-network']).toBeUndefined();
  });
});

describe('pairing', () => {
  it('exchanges a code for a token that then works', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: auth(token) });
    expect(res.status).toBe(200);
  });

  it('pins the requesting origin', async () => {
    await pair();
    expect(loadServeConfig(configFile)!.clients[0]!.origin).toBe(ORIGIN);
  });

  it('refuses when no window is open', async () => {
    const res = await request(port, {
      path: '/v1/pair',
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAAAA' }),
    });
    expect(res.status).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('pairing_closed');
  });

  it('rejects a replayed code', async () => {
    const code = server.state.openPairing();
    const send = () =>
      request(port, {
        path: '/v1/pair',
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(403);
    expect(second.json<{ error: string }>().error).toBe('pairing_closed');
  });

  it('closes the window after five wrong codes, even if the sixth is right', async () => {
    const code = server.state.openPairing();
    const send = (c: string) =>
      request(port, {
        path: '/v1/pair',
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      });
    for (let i = 0; i < 5; i++) expect((await send('ZZZZZZ')).json<{ error: string }>().error).toBeTruthy();
    const final = await send(code);
    expect(final.status).toBe(403);
    expect(final.json<{ error: string }>().error).toBe('pairing_closed');
  });

  it('refuses to pair with a non-extension origin', async () => {
    server.state.openPairing();
    const res = await request(port, {
      path: '/v1/pair',
      method: 'POST',
      headers: { origin: 'https://evil.com', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAAAA' }),
    });
    expect(res.status).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('forbidden_origin');
  });
});

describe('GET /v1/status', () => {
  it('reports project, global and merged counts', async () => {
    const token = await pair();
    const body = (await request(port, { path: '/v1/status', headers: auth(token) })).json<{
      workspace: { nodes: number; root: string };
      global: { nodes: number };
      merged: { nodes: number };
    }>();
    expect(body.workspace.nodes).toBe(3);
    expect(body.global.nodes).toBe(2);
    // 'shared' exists in both; merged is what recall actually sees.
    expect(body.merged.nodes).toBe(4);
    expect(body.workspace.root).toBe(path.join(dir, 'ws'));
  });

  it('reports a corrupt brain as an error rather than failing the request', async () => {
    // The popup must still be able to say "connected".
    const token = await pair();
    fs.writeFileSync(projectBrain, '{ not json');
    const res = await request(port, { path: '/v1/status', headers: auth(token) });
    expect(res.status).toBe(200);
    expect(res.json<{ workspace: { error?: string } }>().workspace.error).toBeTruthy();
  });
});

describe('POST /v1/clip', () => {
  it('enqueues a clip against the global brain by default', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/clip',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'selection', text: 'a fact', url: 'https://example.com/a' }),
    });
    expect(res.status).toBe(201);
    expect(res.json<{ target: string; pending: number }>()).toMatchObject({ target: 'global', pending: 1 });
    expect(clipQueueStats(globalBrain).pending).toBe(1);
    expect(clipQueueStats(projectBrain).pending).toBe(0);
  });

  it('honours an explicit project target', async () => {
    const token = await pair();
    await request(port, {
      path: '/v1/clip',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'selection', text: 'a fact', target: 'project' }),
    });
    expect(clipQueueStats(projectBrain).pending).toBe(1);
  });

  it('rejects a clip with nothing worth storing', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/clip',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'selection', text: '  ' }),
    });
    expect(res.status).toBe(400);
  });

  it('keeps concurrent posts from tearing each other', async () => {
    const token = await pair();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(port, {
          path: '/v1/clip',
          method: 'POST',
          headers: auth(token, { 'content-type': 'application/json' }),
          body: JSON.stringify({ kind: 'selection', text: `clip ${i}` }),
        }),
      ),
    );
    expect(clipQueueStats(globalBrain).pending).toBe(40);
    const raw = fs.readFileSync(path.join(path.dirname(globalBrain), 'clips.jsonl'), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(40);
  });
});

describe('negative matrix', () => {
  // Every case here also asserts the response carries NO CORS header, so a
  // rejected caller can never read the body cross-origin either.
  const noCors = (res: Reply) => expect(res.headers['access-control-allow-origin']).toBeUndefined();

  it('401s with no Authorization', async () => {
    await pair();
    const res = await request(port, { path: '/v1/status', headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  it('401s with a wrong token', async () => {
    await pair();
    const res = await request(port, { path: '/v1/status', headers: auth('not-the-token') });
    expect(res.status).toBe(401);
  });

  it('401s when the token is only in the query string', async () => {
    const token = await pair();
    const res = await request(port, { path: `/v1/status?token=${token}`, headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });

  it('409s workspace_mismatch when the paired client belongs to a different workspace', async () => {
    // Simulates: pair against a server bound to workspace A, stop it, start a
    // fresh `nff-brain serve` in workspace B on the same port — the token is
    // still valid, but must not go on silently authenticating into B's brain.
    const token = await pair();
    const cfg = server.state.config();
    cfg.clients[0]!.workspaceRoot = path.join(dir, 'a-completely-different-workspace');
    saveServeConfig(cfg, configFile);

    // The paired extension origin still gets CORS (unlike the adversarial
    // cases below) — it must be able to read this error to prompt a re-pair.
    const res = await request(port, { path: '/v1/status', headers: auth(token) });
    expect(res.status).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('workspace_mismatch');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('409s a legacy client with no workspaceRoot at all (pre-upgrade serve.json)', async () => {
    const token = await pair();
    const cfg = server.state.config();
    delete cfg.clients[0]!.workspaceRoot;
    saveServeConfig(cfg, configFile);

    const res = await request(port, { path: '/v1/status', headers: auth(token) });
    expect(res.status).toBe(409);
  });

  it('403s a web page origin even with a VALID token', async () => {
    // An exfiltrated token must be useless from a page.
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: { origin: 'https://evil.com', authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    noCors(res);
  });

  it('403s a DIFFERENT extension with a valid token (adversary B)', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: { origin: OTHER_ORIGIN, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    noCors(res);
  });

  it('403s a rebound Host even with a valid origin and token (adversary C)', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: { ...auth(token), host: 'evil.com' } });
    expect(res.status).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('bad_host');
    noCors(res);
  });

  it('403s a top-level navigation', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: { ...auth(token), 'sec-fetch-mode': 'navigate' } });
    expect(res.status).toBe(403);
  });

  it('403s an <img>/<script> style subresource probe', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/status', headers: { ...auth(token), 'sec-fetch-dest': 'image' } });
    expect(res.status).toBe(403);
  });

  it('415s a non-JSON POST (the HTML-form CSRF shape)', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/clip',
      method: 'POST',
      headers: auth(token, { 'content-type': 'text/plain' }),
      body: 'kind=selection',
    });
    expect(res.status).toBe(415);
  });

  it('413s an oversized body without buffering it', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/clip',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'selection', text: 'x'.repeat(1024 * 1024) }),
    }).catch(() => ({ status: 413 }) as Reply);
    expect(res.status).toBe(413);
  });

  it('405s an unsupported method and says what is allowed', async () => {
    const res = await request(port, { path: '/v1/status', method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toContain('GET');
  });

  it.each(['/v1/../../etc/passwd', '/v1/nope', '/', '/v1/'])('404s %s with no filesystem access', async (p) => {
    const res = await request(port, { path: p });
    expect(res.status).toBe(404);
  });

  it('429s a flooding web page while the paired extension keeps working', async () => {
    // THE DoS-ISOLATION ASSERTION at the HTTP layer. A hostile page can hammer
    // 127.0.0.1 all it likes; it must never be able to lock the user out of
    // their own brain.
    const token = await pair();
    let lastPageStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request(port, { path: '/v1/status', headers: { origin: 'https://evil.com' } });
      lastPageStatus = res.status;
    }
    expect(lastPageStatus).toBe(429);

    const ok = await request(port, { path: '/v1/status', headers: auth(token) });
    expect(ok.status).toBe(200);
  });

  it('gives the paired bucket its own, larger budget for bad tokens', async () => {
    const token = await pair();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await request(port, { path: '/v1/status', headers: auth('wrong-token') });
      last = res.status;
    }
    expect(last).toBe(429);
    // A correct token still cannot get through while that bucket is spent —
    // this bucket exists to slow a compromised extension guessing tokens.
    expect((await request(port, { path: '/v1/status', headers: auth(token) })).status).toBe(429);
  });

  it('401s an admin route presented with a mere client token', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/admin/clients', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('403s an admin route that carries any Origin at all', async () => {
    const admin = loadServeConfig(configFile)!.adminToken;
    const res = await request(port, {
      path: '/v1/admin/clients',
      headers: { origin: ORIGIN, authorization: `Bearer ${admin}` },
    });
    expect(res.status).toBe(403);
  });

  it('serves admin routes to the CLI on loopback with the admin token', async () => {
    await pair();
    const admin = loadServeConfig(configFile)!.adminToken;
    const res = await request(port, { path: '/v1/admin/clients', headers: { authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
    expect(res.json<{ clients: unknown[] }>().clients).toHaveLength(1);
    // Client tokens must never appear in an admin listing either.
    expect(res.body).not.toContain('tokenHash');
  });
});

describe('clip→node feedback loop (/v1/clips/map + /v1/retract)', () => {
  function writeRichBrain(file: string, nodes: Array<{ id: string; origin: string }>) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        nodes: nodes.map((n) => ({
          id: n.id,
          title: n.id,
          category: 'strategy',
          content: `content ${n.id}`,
          color: '#a78bfa',
          x: 0,
          y: 0,
          size: 16,
          origin: n.origin,
          lastUpdated: new Date().toISOString(),
          recallCount: 0,
        })),
        edges: [{ from: nodes[0]!.id, to: nodes[nodes.length - 1]!.id, strength: 0.5 }],
      }),
    );
  }

  async function pairAndLedger(): Promise<{ token: string; clientId: string }> {
    const token = await pair();
    const clientId = loadServeConfig(configFile)!.clients[0]!.id;
    writeRichBrain(globalBrain, [
      { id: 'clip-one', origin: 'clip' },
      { id: 'clip-two', origin: 'clip' },
      { id: 'agent-node', origin: 'agent' },
    ]);
    appendClipMap(globalBrain, [
      { clipId: 'clp_mine_1', clientId, nodeIds: ['clip-one'] },
      { clipId: 'clp_mine_2', clientId, nodeIds: ['clip-two'] },
      { clipId: 'clp_theirs', clientId: 'cl_other', nodeIds: ['clip-two'] },
      // A poisoned ledger line claiming an agent node came from our clip:
      { clipId: 'clp_poison', clientId, nodeIds: ['agent-node'] },
    ]);
    return { token, clientId };
  }

  it('clips/map returns only the requesting client’s own entries', async () => {
    const { token } = await pairAndLedger();
    const res = await request(port, { path: '/v1/clips/map', headers: auth(token) });
    expect(res.status).toBe(200);
    const map = res.json<{ map: Array<{ clipId: string }> }>().map;
    expect(map.map((e) => e.clipId).sort()).toEqual(['clp_mine_1', 'clp_mine_2', 'clp_poison']);
    expect(map.some((e) => e.clipId === 'clp_theirs')).toBe(false);
  });

  it('clips/map requires auth and a paired origin like every client route', async () => {
    const { token } = await pairAndLedger();
    expect((await request(port, { path: '/v1/clips/map', headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await request(port, { path: '/v1/clips/map', headers: auth(token, { origin: OTHER_ORIGIN }) })).status).toBe(403);
  });

  it('retract deletes only origin-clip nodes attributed to the caller', async () => {
    const { token } = await pairAndLedger();
    const res = await request(port, {
      path: '/v1/retract',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      // clip-one: ours → goes. agent-node: attributed via poisoned ledger but
      // wrong ORIGIN → stays. g1/ghost: not attributed → stay/no-op.
      body: JSON.stringify({ nodeIds: ['clip-one', 'agent-node', 'ghost'] }),
    });
    expect(res.status).toBe(200);
    expect(res.json<{ removed: string[] }>().removed).toEqual(['clip-one']);

    const brain = JSON.parse(fs.readFileSync(globalBrain, 'utf8'));
    expect(brain.nodes.some((n: any) => n.id === 'clip-one')).toBe(false);
    expect(brain.nodes.some((n: any) => n.id === 'agent-node')).toBe(true);
    // Touching edges went with the node; the ledger no longer names it.
    expect(brain.edges.some((e: any) => e.from === 'clip-one' || e.to === 'clip-one')).toBe(false);
    const ledger = readClipMap(globalBrain);
    expect(ledger.flatMap((e) => e.nodeIds)).not.toContain('clip-one');
  });

  it('a client cannot retract nodes another client’s clips created', async () => {
    const { token } = await pairAndLedger();
    // clip-two is attributed to BOTH cl_other and us (clp_mine_2), so it IS
    // retractable by us; strip our attribution to model the pure-other case.
    compactClipMap(globalBrain, { dropNodeIds: new Set() });
    const entries = readClipMap(globalBrain).filter((e) => e.clipId !== 'clp_mine_2');
    fs.writeFileSync(clipMapPath(globalBrain), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const res = await request(port, {
      path: '/v1/retract',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ nodeIds: ['clip-two'] }),
    });
    expect(res.json<{ removed: string[] }>().removed).toEqual([]);
    const brain = JSON.parse(fs.readFileSync(globalBrain, 'utf8'));
    expect(brain.nodes.some((n: any) => n.id === 'clip-two')).toBe(true);
  });
});

describe('DevTools panel routes (/v1/nodes + /v1/search)', () => {
  function writePanelBrain(file: string, nodes: Array<{ id: string; title: string; content: string; at: string }>) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: nodes.map((n) => n.at).sort().at(-1) ?? new Date().toISOString(),
        nodes: nodes.map((n) => ({
          id: n.id,
          title: n.title,
          category: 'strategy',
          content: n.content,
          color: '#a78bfa',
          x: 0,
          y: 0,
          size: 16,
          origin: 'agent',
          lastUpdated: n.at,
          recallCount: 0,
        })),
        edges: nodes.length >= 2 ? [{ from: nodes[0]!.id, to: nodes[1]!.id, strength: 0.7 }] : [],
      }),
    );
  }

  function seedPanelBrains() {
    writePanelBrain(projectBrain, [
      { id: 'docker-dns-wedge', title: 'Docker DNS wedge', content: 'When the fleet looks offline force-recreate the container', at: '2026-08-02T00:00:00.000Z' },
      { id: 'compose-env', title: 'Compose env gotcha', content: 'env leaks paths into docker compose', at: '2026-08-03T00:00:00.000Z' },
      { id: 'shared', title: 'Shared project version', content: 'project wins on collision', at: '2026-08-01T00:00:00.000Z' },
    ]);
    writePanelBrain(globalBrain, [
      { id: 'shared', title: 'Shared global version', content: 'global loses on collision', at: '2026-07-01T00:00:00.000Z' },
      { id: 'oauth-cb', title: 'OAuth callback rule', content: 'loopback only for the oauth callback url', at: '2026-07-02T00:00:00.000Z' },
    ]);
  }

  it('nodes: merged counts dedupe collisions, recent sorted desc, limit respected', async () => {
    const token = await pair();
    seedPanelBrains();
    const res = await request(port, { path: '/v1/nodes', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<any>();
    expect(body.merged.nodes).toBe(4); // p×3 + g×2, 'shared' counted once
    expect(body.workspace.nodes).toBe(3);
    expect(body.global.nodes).toBe(2);
    expect(body.workspace.name).toBe('ws');
    expect(body.recent[0].id).toBe('compose-env'); // newest lastUpdated first
    expect(body.recent.find((n: any) => n.id === 'shared').source).toBe('project');

    const limited = await request(port, { path: '/v1/nodes?limit=1', headers: auth(token) });
    expect(limited.json<any>().recent).toHaveLength(1);
  });

  it('nodes: an on-disk rewrite is visible on the next request — the live-update guarantee', async () => {
    const token = await pair();
    seedPanelBrains();
    const before = (await request(port, { path: '/v1/nodes', headers: auth(token) })).json<any>();
    // A SessionEnd distill writes brain.json while the panel is open:
    writePanelBrain(projectBrain, [
      { id: 'docker-dns-wedge', title: 'Docker DNS wedge', content: 'x', at: '2026-08-02T00:00:00.000Z' },
      { id: 'compose-env', title: 'Compose env gotcha', content: 'y', at: '2026-08-03T00:00:00.000Z' },
      { id: 'shared', title: 'Shared project version', content: 'z', at: '2026-08-01T00:00:00.000Z' },
      { id: 'fresh-lesson', title: 'Fresh lesson', content: 'just distilled', at: '2026-08-11T00:00:00.000Z' },
    ]);
    const after = (await request(port, { path: '/v1/nodes', headers: auth(token) })).json<any>();
    expect(after.merged.nodes).toBe(before.merged.nodes + 1);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.recent[0].id).toBe('fresh-lesson');
  });

  it('search: ranks matches, includes source/excerpt/related, caps related at 3', async () => {
    const token = await pair();
    seedPanelBrains();
    const res = await request(port, { path: '/v1/search?q=docker%20offline%20fleet', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<any>();
    expect(body.count).toBeGreaterThan(0);
    expect(body.hits[0].id).toBe('docker-dns-wedge');
    expect(body.hits[0].source).toBe('project');
    expect(typeof body.hits[0].score).toBe('number');
    expect(body.hits[0].excerpt.length).toBeLessThanOrEqual(240);
    // The seeded edge surfaces as a citation.
    expect(body.hits[0].related.map((r: any) => r.id)).toContain('compose-env');
    expect(body.hits[0].related.length).toBeLessThanOrEqual(3);
  });

  it('search: empty q is ok+empty (as-you-type), unknown terms are count 0', async () => {
    const token = await pair();
    seedPanelBrains();
    const empty = (await request(port, { path: '/v1/search?q=', headers: auth(token) })).json<any>();
    expect(empty.ok).toBe(true);
    expect(empty.hits).toEqual([]);
    const none = (await request(port, { path: '/v1/search?q=zzzzqqqqxxyy', headers: auth(token) })).json<any>();
    expect(none.count).toBe(0);
  });

  it('both routes demand auth + the paired origin like every client route', async () => {
    const token = await pair();
    expect((await request(port, { path: '/v1/nodes', headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await request(port, { path: '/v1/search?q=x', headers: auth(token, { origin: OTHER_ORIGIN }) })).status).toBe(403);
  });

  it('a corrupt project brain degrades to global-only data, never a 500', async () => {
    const token = await pair();
    seedPanelBrains();
    fs.writeFileSync(projectBrain, '{ definitely not json');
    const res = await request(port, { path: '/v1/nodes', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<any>();
    expect(body.workspace.nodes).toBe(0);
    expect(body.merged.nodes).toBe(2); // the global side still serves
  });

  it('graph: returns every node with its stored geometry, plus edges — no cap like /v1/nodes recent', async () => {
    const token = await pair();
    seedPanelBrains();
    const res = await request(port, { path: '/v1/graph', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<any>();
    expect(body.nodes).toHaveLength(4); // p×3 + g×2, 'shared' counted once, same dedupe as /v1/nodes
    for (const n of body.nodes) {
      expect(typeof n.x).toBe('number');
      expect(typeof n.y).toBe('number');
      expect(typeof n.size).toBe('number');
      expect(typeof n.color).toBe('string');
    }
    const ids = body.nodes.map((n: any) => n.id);
    expect(ids).toContain('docker-dns-wedge');
    expect(ids).toContain('shared');
    const edgeIds = body.edges.map((e: any) => `${e.from}->${e.to}`);
    expect(edgeIds).toContain('docker-dns-wedge->compose-env');
  });

  it('graph demands auth + the paired origin like every client route', async () => {
    const token = await pair();
    expect((await request(port, { path: '/v1/graph', headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await request(port, { path: '/v1/graph', headers: auth(token, { origin: OTHER_ORIGIN }) })).status).toBe(403);
  });

  it('graph: a corrupt project brain degrades to global-only data, never a 500', async () => {
    const token = await pair();
    seedPanelBrains();
    fs.writeFileSync(projectBrain, '{ definitely not json');
    const res = await request(port, { path: '/v1/graph', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<any>();
    expect(body.nodes).toHaveLength(2); // the global side still serves
  });

  describe('POST /v1/layout', () => {
    it('writes exactly the dropped x/y to the file that owns the node, without touching the other one', async () => {
      const token = await pair();
      seedPanelBrains();
      const beforeGlobal = JSON.parse(fs.readFileSync(globalBrain, 'utf8'));
      const res = await request(port, {
        path: '/v1/layout',
        method: 'POST',
        headers: auth(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ id: 'docker-dns-wedge', x: 123.5, y: -40 }),
      });
      expect(res.status).toBe(200);
      expect(res.json<any>()).toEqual({ ok: true, moved: true });

      const project = JSON.parse(fs.readFileSync(projectBrain, 'utf8'));
      const node = project.nodes.find((n: any) => n.id === 'docker-dns-wedge');
      expect(node.x).toBe(123.5);
      expect(node.y).toBe(-40);
      expect(node.laidOut).toBe(true);
      // The file that does NOT own this node must not be resaved.
      const afterGlobal = JSON.parse(fs.readFileSync(globalBrain, 'utf8'));
      expect(afterGlobal.updatedAt).toBe(beforeGlobal.updatedAt);
    });

    it('routes to whichever file owns a collided id — project wins, matching /v1/graph', async () => {
      const token = await pair();
      seedPanelBrains();
      const res = await request(port, {
        path: '/v1/layout',
        method: 'POST',
        headers: auth(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ id: 'shared', x: 10, y: 20 }),
      });
      expect(res.status).toBe(200);
      const project = JSON.parse(fs.readFileSync(projectBrain, 'utf8'));
      expect(project.nodes.find((n: any) => n.id === 'shared').x).toBe(10);
      const global = JSON.parse(fs.readFileSync(globalBrain, 'utf8'));
      expect(global.nodes.find((n: any) => n.id === 'shared').x).toBe(0); // untouched, seeded value
    });

    it('an unknown id is a 200 no-op, not an error', async () => {
      const token = await pair();
      seedPanelBrains();
      const res = await request(port, {
        path: '/v1/layout',
        method: 'POST',
        headers: auth(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ id: 'no-such-node', x: 1, y: 2 }),
      });
      expect(res.status).toBe(200);
      expect(res.json<any>()).toEqual({ ok: true, moved: false });
    });

    it('rejects a missing id or non-finite x/y', async () => {
      const token = await pair();
      seedPanelBrains();
      for (const body of [{ x: 1, y: 2 }, { id: 'shared', x: 'nope', y: 2 }, { id: 'shared', x: Infinity, y: 2 }]) {
        const res = await request(port, {
          path: '/v1/layout',
          method: 'POST',
          headers: auth(token, { 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }
    });

    it('demands auth + the paired origin like every client route', async () => {
      const token = await pair();
      seedPanelBrains();
      const body = JSON.stringify({ id: 'shared', x: 1, y: 2 });
      expect(
        (await request(port, { path: '/v1/layout', method: 'POST', headers: { origin: ORIGIN }, body })).status,
      ).toBe(401);
      expect(
        (await request(port, { path: '/v1/layout', method: 'POST', headers: auth(token, { origin: OTHER_ORIGIN }), body })).status,
      ).toBe(403);
    });
  });
});
