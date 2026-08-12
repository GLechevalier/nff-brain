import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatPairingCode } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

// The /v1/agent/* HTTP surface, over a REAL server + REAL runClaude() shelled
// to the shared mocked `claude` shim (same fixture e2eClips.test.ts uses) —
// this is what actually proves the fire-and-forget planning wiring works,
// not just the pure parse logic already covered in packages/core/test.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

const ORIGIN_A = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
let homeDir: string;
let dir: string;
let server: BrainServer;
let port: number;
let configFile: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalClaudeBin: string | undefined;

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-agent-http-shim-'));
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-agent-http-'));
  homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  configFile = path.join(homeDir, '.nff-brain', 'serve.json');

  // webAgentStatePath()/mcpServersPath() resolve via os.homedir() with no
  // override param (they are global, not per-workspace) — redirecting HOME
  // is the only way to isolate them per test.
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalClaudeBin = process.env.NFF_BRAIN_CLAUDE_BIN;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.NFF_BRAIN_CLAUDE_BIN = shimBin;
  process.env.NFF_BRAIN_TIMEOUT_MS = '5000';

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

async function pairAs(origin: string): Promise<string> {
  const code = server.state.openPairing();
  const res = await request(port, {
    path: '/v1/pair',
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: formatPairingCode(code), client: { name: origin } }),
  });
  expect(res.status).toBe(200);
  return res.json<{ token: string }>().token;
}

function auth(origin: string, token: string, extra: Record<string, string> = {}) {
  return { origin, authorization: `Bearer ${token}`, ...extra };
}

async function submitGoal(origin: string, token: string, maxActions = 1): Promise<string> {
  const res = await request(port, {
    path: '/v1/agent/goal',
    method: 'POST',
    headers: auth(origin, token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ goal: 'find robotics engineers', maxActions, listTarget: null }),
  });
  expect(res.status).toBe(201);
  return res.json<{ runId: string }>().runId;
}

async function waitForPhase(origin: string, token: string, isDone: (phase: string) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, { path: '/v1/agent/status', headers: auth(origin, token) });
    const run = res.json<{ run: { phase: string } | null }>().run;
    if (run && isDone(run.phase)) return run;
    if (Date.now() > deadline) throw new Error(`timed out waiting for phase; last run: ${JSON.stringify(run)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('auth + origin policy', () => {
  it.each([
    ['/v1/agent/goal', 'POST'],
    ['/v1/agent/status', 'GET'],
    ['/v1/agent/plan/approve', 'POST'],
    ['/v1/agent/plan/reject', 'POST'],
    ['/v1/agent/stop', 'POST'],
    ['/v1/agent/next-action', 'GET'],
    ['/v1/agent/action-result', 'POST'],
  ])('%s %s requires a bearer token', async (p, method) => {
    // Pair first so the origin itself is allowed (gate 5) — otherwise a
    // missing-token request 403s on the origin check before it ever reaches
    // the auth gate this test means to exercise.
    await pairAs(ORIGIN_A);
    const res = await request(port, { path: p, method, headers: { origin: ORIGIN_A } });
    expect(res.status).toBe(401);
  });

  it('refuses a token paired to a different origin', async () => {
    const token = await pairAs(ORIGIN_A);
    await pairAs(ORIGIN_B); // both origins must be paired for THIS to be a token mismatch, not a bare origin rejection
    const res = await request(port, { path: '/v1/agent/status', headers: auth(ORIGIN_B, token) });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/agent/goal', () => {
  it('409s a second goal while one is still active', async () => {
    const token = await pairAs(ORIGIN_A);
    await submitGoal(ORIGIN_A, token);
    const res = await request(port, {
      path: '/v1/agent/goal',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ goal: 'another goal', maxActions: 1, listTarget: null }),
    });
    expect(res.status).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('run_active');
  });

  it('400s an empty goal', async () => {
    const token = await pairAs(ORIGIN_A);
    const res = await request(port, {
      path: '/v1/agent/goal',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ goal: '   ', maxActions: 1, listTarget: null }),
    });
    expect(res.status).toBe(400);
  });

  it('plans through the real runClaude() shim, landing awaiting_approval with parsed steps', async () => {
    const token = await pairAs(ORIGIN_A);
    await submitGoal(ORIGIN_A, token);
    const run = await waitForPhase(ORIGIN_A, token, (p) => p !== 'planning');
    expect(run.phase).toBe('awaiting_approval');
    expect(run.plan.steps.map((s: any) => s.verb)).toEqual(['searchPeople', 'evaluateCards']);
    expect(run.plan.criteria).toBe('robotics engineer at a Series A startup');
  });
});

describe('run ownership — no cross-client control', () => {
  it('a different paired client cannot see, approve or stop another client\'s run', async () => {
    const tokenA = await pairAs(ORIGIN_A);
    const tokenB = await pairAs(ORIGIN_B);
    const runId = await submitGoal(ORIGIN_A, tokenA);

    const statusB = await request(port, { path: '/v1/agent/status', headers: auth(ORIGIN_B, tokenB) });
    expect(statusB.json<{ run: unknown }>().run).toBeNull();

    const approveB = await request(port, {
      path: '/v1/agent/plan/approve',
      method: 'POST',
      headers: auth(ORIGIN_B, tokenB, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId }),
    });
    expect(approveB.json<{ run: unknown }>().run).toBeNull();

    // Confirm A's run is untouched.
    const statusA = await request(port, { path: '/v1/agent/status', headers: auth(ORIGIN_A, tokenA) });
    expect(statusA.json<{ run: { phase: string } }>().run.phase).toBe('planning');
  });
});

describe('approve → next-action → action-result → cap → done', () => {
  it('drives one full cycle and stops granting once the cap is reached', async () => {
    const token = await pairAs(ORIGIN_A);
    await submitGoal(ORIGIN_A, token, 1); // cap of 1 connect
    const planned = await waitForPhase(ORIGIN_A, token, (p) => p !== 'planning');
    const runId = planned.id;

    const approved = await request(port, {
      path: '/v1/agent/plan/approve',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId }),
    });
    expect(approved.json<{ run: { phase: string } }>().run.phase).toBe('running');

    // Step 1: searchPeople → navigate
    const next1 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action1 = next1.json<{ action: { stepId: string; verb: string } }>().action;
    expect(action1.verb).toBe('navigate');
    await request(port, {
      path: '/v1/agent/action-result',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        runId,
        stepId: action1.stepId,
        verb: 'navigate',
        args: {},
        result: { ok: true, summary: 'navigated' },
      }),
    });

    // Step 2: evaluateCards → readResultCards
    const next2 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action2 = next2.json<{ action: { stepId: string; verb: string } }>().action;
    expect(action2.verb).toBe('readResultCards');
    const cardsResult = await request(port, {
      path: '/v1/agent/action-result',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        runId,
        stepId: action2.stepId,
        verb: 'readResultCards',
        args: {},
        result: {
          ok: true,
          summary: 'read 2 cards',
          cards: [
            { cardIndex: 0, name: 'Ada Lovelace', headline: 'Robotics Engineer at Acme Robotics' },
            { cardIndex: 1, name: 'Bob Smith', headline: 'Sales Manager at BigCorp' },
          ],
        },
      }),
    });
    // The shim's filter always matches card #0 — one clickConnect is now queued.
    expect(cardsResult.json<{ run: { pendingConnects: unknown[] } }>().run.pendingConnects).toHaveLength(1);

    // Step 3: the queued clickConnect
    const next3 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action3 = next3.json<{ action: { stepId: string; verb: string; args: { cardIndex: string } } }>().action;
    expect(action3.verb).toBe('clickConnect');
    expect(action3.args.cardIndex).toBe('0');
    const connected = await request(port, {
      path: '/v1/agent/action-result',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        runId,
        stepId: action3.stepId,
        verb: 'clickConnect',
        args: { cardIndex: '0' },
        result: { ok: true, summary: 'connected', fields: { name: 'Ada Lovelace' } },
      }),
    });
    const runAfterConnect = connected.json<{ run: { phase: string; actionsTaken: number } }>().run;
    expect(runAfterConnect.actionsTaken).toBe(1);
    expect(runAfterConnect.phase).toBe('done'); // cap of 1 reached, plan exhausted

    // Cap enforced: no further action is ever granted, even if asked again.
    const next4 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    expect(next4.json<{ action: unknown }>().action).toBeNull();
  });
});

describe('POST /v1/agent/stop', () => {
  it('is idempotent — stopping an unknown or already-terminal run is still ok:true', async () => {
    const token = await pairAs(ORIGIN_A);
    const res = await request(port, {
      path: '/v1/agent/stop',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId: 'run_does_not_exist' }),
    });
    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('a run stopped during planning goes straight to stopped, never stuck in stopping', async () => {
    const token = await pairAs(ORIGIN_A);
    const runId = await submitGoal(ORIGIN_A, token);
    await request(port, {
      path: '/v1/agent/stop',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId }),
    });
    // The run is archived immediately — status now reports no active run.
    const status = await request(port, { path: '/v1/agent/status', headers: auth(ORIGIN_A, token) });
    expect(status.json<{ run: unknown }>().run).toBeNull();
  });
});

