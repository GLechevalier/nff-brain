import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMcpServer, formatPairingCode, saveMcpServers } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// The /v1/mcp/* HTTP surface — the generic, plug-and-play MCP client's
// extension-facing half. Registration (mcp add) is CLI-only and out of
// scope here; these routes only ever list already-registered servers and
// call an already-registered tool.

const ORIGIN = 'chrome-extension://cccccccccccccccccccccccccccccccc';

interface Reply {
  status: number;
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(body || '{}') }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A minimal MCP-over-HTTP stand-in, stateless like the client expects. */
function startMockMcpServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params: unknown };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (rpc.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { tools: [{ name: 'crm_create_contact', description: 'Create a contact', inputSchema: { type: 'object' } }] },
            }),
          );
        } else if (rpc.method === 'tools/call') {
          const args = rpc.params as { name?: string };
          if (args?.name === 'broken_tool') {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'tool exploded' } }));
          } else {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'created cont_123' }] } }));
          }
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unknown method' } }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let dir: string;
let homeDir: string;
let server: BrainServer;
let mockMcp: http.Server;
let port: number;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-mcp-http-'));
  homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  configFile = path.join(homeDir, '.nff-brain', 'serve.json');

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  mockMcp = await startMockMcpServer();

  server = await startBrainServer({
    port: 0,
    workspaceRoot: path.join(dir, 'ws'),
    projectBrainPath: path.join(dir, 'ws', '.nff-brain', 'brain.json'),
    globalBrainPath: path.join(homeDir, '.nff-brain', 'brain.json'),
    allowOrigins: [],
    cliVersion: '0.0.0-test',
    configFile,
  });
  port = server.port;
});

afterEach(async () => {
  await server.close();
  await new Promise<void>((resolve) => mockMcp.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
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

function auth(token: string, extra: Record<string, string> = {}) {
  return { origin: ORIGIN, authorization: `Bearer ${token}`, ...extra };
}

function registerMockServer(): string {
  const { port: mockPort } = mockMcp.address() as { port: number };
  const { server: entry } = addMcpServer([], { name: 'test-mcp', url: `http://127.0.0.1:${mockPort}/mcp`, headers: { 'X-Secret': 'sekrit' } });
  saveMcpServers([entry]);
  return entry.id;
}

describe('auth + origin policy', () => {
  it.each([
    ['/v1/mcp/servers', 'GET'],
    ['/v1/mcp/tools', 'GET'],
    ['/v1/mcp/call', 'POST'],
  ])('%s %s requires a bearer token', async (p, method) => {
    await pair(); // register the origin so the request reaches the auth gate, not the origin gate
    const res = await request(port, { path: p, method, headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/mcp/servers', () => {
  it('lists registered servers without ever echoing headers/secrets', async () => {
    const token = await pair();
    registerMockServer();
    const res = await request(port, { path: '/v1/mcp/servers', headers: auth(token) });
    expect(res.status).toBe(200);
    const body = res.json<{ servers: Array<{ id: string; name: string; enabled: boolean }> }>();
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].name).toBe('test-mcp');
    expect(JSON.stringify(body)).not.toContain('sekrit');
    expect(JSON.stringify(body)).not.toContain('X-Secret');
  });

  it('an empty registry is an empty list, not an error', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/mcp/servers', headers: auth(token) });
    expect(res.json<{ servers: unknown[] }>().servers).toEqual([]);
  });
});

describe('GET /v1/mcp/tools', () => {
  it('proxies a live tools/list call to the registered server', async () => {
    const token = await pair();
    const id = registerMockServer();
    const res = await request(port, { path: `/v1/mcp/tools?server=${id}`, headers: auth(token) });
    expect(res.status).toBe(200);
    expect(res.json<{ tools: Array<{ name: string }> }>().tools).toEqual([
      { name: 'crm_create_contact', description: 'Create a contact', inputSchema: { type: 'object' } },
    ]);
  });

  it('400s an unknown server id', async () => {
    const token = await pair();
    const res = await request(port, { path: '/v1/mcp/tools?server=does_not_exist', headers: auth(token) });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/mcp/call', () => {
  it('calls the tool through the registered server and returns its content', async () => {
    const token = await pair();
    const id = registerMockServer();
    const res = await request(port, {
      path: '/v1/mcp/call',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ server: id, tool: 'crm_create_contact', args: { name: 'Ada Lovelace' } }),
    });
    expect(res.status).toBe(200);
    expect(res.json<{ result: unknown }>().result).toEqual([{ type: 'text', text: 'created cont_123' }]);
  });

  it('502s with mcp_error when the target server itself errors', async () => {
    const token = await pair();
    const id = registerMockServer();
    const res = await request(port, {
      path: '/v1/mcp/call',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ server: id, tool: 'broken_tool', args: {} }),
    });
    expect(res.status).toBe(502);
    expect(res.json<{ error: string; message: string }>()).toMatchObject({ error: 'mcp_error', message: 'tool exploded' });
  });

  it('400s when the server id or tool name is missing/unknown', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/mcp/call',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ server: 'no_such_server', tool: 'x', args: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/mcp/servers/enable', () => {
  it('flips enabled without ever touching url/headers', async () => {
    const token = await pair();
    const id = registerMockServer();
    const res = await request(port, {
      path: '/v1/mcp/servers/enable',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id, enabled: false }),
    });
    expect(res.status).toBe(200);
    const servers = res.json<{ servers: Array<{ id: string; enabled: boolean }> }>().servers;
    expect(servers.find((s) => s.id === id)?.enabled).toBe(false);
    expect(JSON.stringify(res.json())).not.toContain('sekrit');

    const reEnabled = await request(port, {
      path: '/v1/mcp/servers/enable',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id, enabled: true }),
    });
    expect(reEnabled.json<{ servers: Array<{ id: string; enabled: boolean }> }>().servers.find((s) => s.id === id)?.enabled).toBe(true);
  });

  it('400s an unknown server id', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/mcp/servers/enable',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id: 'no_such_server', enabled: false }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/mcp/servers/remove', () => {
  it('removes an already-registered server', async () => {
    const token = await pair();
    const id = registerMockServer();
    const res = await request(port, {
      path: '/v1/mcp/servers/remove',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id }),
    });
    expect(res.status).toBe(200);
    expect(res.json<{ servers: unknown[] }>().servers).toEqual([]);

    const after = await request(port, { path: '/v1/mcp/servers', headers: auth(token) });
    expect(after.json<{ servers: unknown[] }>().servers).toEqual([]);
  });

  it('400s an unknown server id', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/mcp/servers/remove',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ id: 'no_such_server' }),
    });
    expect(res.status).toBe(400);
  });
});
