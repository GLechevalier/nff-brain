import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatPairingCode } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// POST /v1/act/step over a REAL server + the shared mocked `claude` shim — the
// paired web agent's brain step. Proves the auth/origin gating and the thin
// claude -p passthrough, mirroring chatHttp.test.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');
const ORIGIN = 'chrome-extension://dddddddddddddddddddddddddddddddd';

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

let shimDir: string;
let shimBin: string;
let dir: string;
let homeDir: string;
let server: BrainServer;
let port: number;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalClaudeBin: string | undefined;

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-act-http-shim-'));
  if (process.platform === 'win32') {
    shimBin = path.join(shimDir, 'claude.cmd');
    fs.writeFileSync(shimBin, `@echo off\r\nnode "${SHIM_JS}" %*\r\n`);
  } else {
    shimBin = path.join(shimDir, 'claude');
    fs.writeFileSync(shimBin, `#!/bin/sh\nexec node "${SHIM_JS}" "$@"\n`);
    fs.chmodSync(shimBin, 0o755);
  }
});

afterAll(() => {
  fs.rmSync(shimDir, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-act-http-'));
  homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  configFile = path.join(homeDir, '.nff-brain', 'serve.json');

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalClaudeBin = process.env.NFF_BRAIN_CLAUDE_BIN;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.NFF_BRAIN_CLAUDE_BIN = shimBin;
  process.env.NFF_BRAIN_TIMEOUT_MS = '5000';

  fs.mkdirSync(path.join(homeDir, '.nff-brain'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.nff-brain', 'brain.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), nodes: [], edges: [] }),
  );

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
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  process.env.NFF_BRAIN_CLAUDE_BIN = originalClaudeBin;
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

describe('POST /v1/act/step', () => {
  it('requires a bearer token', async () => {
    await pair();
    const res = await request(port, {
      path: '/v1/act/step',
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('400s an empty prompt', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/act/step',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns the claude -p text for a valid prompt', async () => {
    const token = await pair();
    const res = await request(port, {
      path: '/v1/act/step',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt: 'read the page and decide the next action' }),
    });
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; text: string }>();
    expect(body.ok).toBe(true);
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
  });
});
