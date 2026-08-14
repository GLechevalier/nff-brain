import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatPairingCode } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// POST /v1/act/session/step + /end over a REAL server + the stream-json mode of
// the shared claude shim — the paired web agent's PERSISTENT brain. The shim
// embeds its pid and a per-process turn counter in every reply, which is how
// these tests PROVE one process answered successive turns (the whole point of
// the session route) and that death/expiry respawns are transparent.
// The suite finishing without a hang is itself the "server close kills
// children" check — a leaked shim would hold vitest open.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');
const ORIGIN = 'chrome-extension://dddddddddddddddddddddddddddddddd';
const RUN = 'act_1723000000_abc123';

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
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'NFF_BRAIN_CLAUDE_BIN', 'NFF_BRAIN_TIMEOUT_MS', 'SHIM_MODE', 'NFF_BRAIN_ACT_IDLE_MS', 'NFF_BRAIN_ACT_SESSION'];

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-act-session-shim-'));
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-act-session-'));
  homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  configFile = path.join(homeDir, '.nff-brain', 'serve.json');

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.NFF_BRAIN_CLAUDE_BIN = shimBin;
  process.env.NFF_BRAIN_TIMEOUT_MS = '5000';
  delete process.env.SHIM_MODE;
  delete process.env.NFF_BRAIN_ACT_IDLE_MS;
  delete process.env.NFF_BRAIN_ACT_SESSION;

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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

async function step(token: string, body: Record<string, unknown>): Promise<Reply> {
  return request(port, {
    path: '/v1/act/session/step',
    method: 'POST',
    headers: auth(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** The shim answers `pid:<pid> turn:<n> saw:<first 60 chars of the user text>`. */
function parseShim(text: string): { pid: string; turn: number; saw: string } {
  const m = /^pid:(\d+) turn:(\d+) saw:([\s\S]*)$/.exec(text);
  expect(m, `unexpected shim reply: ${text}`).toBeTruthy();
  return { pid: m![1]!, turn: Number(m![2]), saw: m![3]! };
}

const BODY = { runId: RUN, bootstrap: 'BOOTSTRAP prompt with history', message: 'MESSAGE result of last action' };

describe('POST /v1/act/session/step', () => {
  it('requires a bearer token', async () => {
    await pair();
    const res = await request(port, {
      path: '/v1/act/session/step',
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(401);
  });

  it('400s missing or malformed fields', async () => {
    const token = await pair();
    for (const bad of [
      { ...BODY, runId: 'not-an-act-id' },
      { ...BODY, bootstrap: '  ' },
      { ...BODY, message: '' },
      { runId: RUN },
    ]) {
      const res = await step(token, bad);
      expect(res.status).toBe(400);
    }
  });

  it('reuses ONE claude process across steps: same pid, counting turns', async () => {
    const token = await pair();
    const r1 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    const r2 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    expect(r2.pid).toBe(r1.pid);
    expect(r1.turn).toBe(1);
    expect(r2.turn).toBe(2);
    // Turn 1 was fed the bootstrap (full prompt), turn 2 only the delta message.
    expect(r1.saw).toContain('BOOTSTRAP');
    expect(r2.saw).toContain('MESSAGE');
  });

  it('end kills the session; the next step bootstraps a fresh process', async () => {
    const token = await pair();
    const r1 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    const end = await request(port, {
      path: '/v1/act/session/end',
      method: 'POST',
      headers: auth(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId: RUN }),
    });
    expect(end.status).toBe(200);
    expect(end.json<{ ended: boolean }>().ended).toBe(true);
    const r2 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    expect(r2.pid).not.toBe(r1.pid);
    expect(r2.turn).toBe(1);
    expect(r2.saw).toContain('BOOTSTRAP');
  });

  it('transparently respawns from bootstrap when the process dies mid-run', async () => {
    process.env.SHIM_MODE = 'die-after-1';
    const token = await pair();
    const r1 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    // The shim exited right after answering; the next step must still succeed.
    const res2 = await step(token, BODY);
    expect(res2.status).toBe(200);
    const r2 = parseShim(res2.json<{ text: string }>().text);
    expect(r2.pid).not.toBe(r1.pid);
    expect(r2.saw).toContain('BOOTSTRAP');
  });

  it('expires an idle session and bootstraps the next step', async () => {
    process.env.NFF_BRAIN_ACT_IDLE_MS = '50';
    const token = await pair();
    const r1 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    await new Promise((r) => setTimeout(r, 250));
    const r2 = parseShim((await step(token, BODY)).json<{ text: string }>().text);
    expect(r2.pid).not.toBe(r1.pid);
    expect(r2.saw).toContain('BOOTSTRAP');
  });

  it('NFF_BRAIN_ACT_SESSION=0 falls back to a one-shot on the bootstrap', async () => {
    process.env.NFF_BRAIN_ACT_SESSION = '0';
    const token = await pair();
    const res = await step(token, BODY);
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; text: string }>();
    expect(body.ok).toBe(true);
    // The legacy one-shot shim path answered (not the stream-json pid format).
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.text).not.toMatch(/^pid:/);
  });
});
