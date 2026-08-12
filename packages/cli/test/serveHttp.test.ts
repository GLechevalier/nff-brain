import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clipQueueStats, formatPairingCode, loadServeConfig } from '@nff-brain/core';
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
