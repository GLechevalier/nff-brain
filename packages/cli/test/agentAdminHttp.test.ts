// The /v1/admin/agent/* surface — how `nff-brain agent …` and the eval
// harness drive the web agent WITHOUT the extension's bearer token. Same
// real-server + real-runClaude()-shim rig as agentHttp.test.ts; kept as its
// own file because the trust model under test is different: admin acts ON
// BEHALF OF a paired client, so what matters here is attribution (the run
// lands on the right client and the ordinary client routes execute it) and
// that the admin surface stays unreachable from any browser context.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatPairingCode } from '@nff-brain/core';
import { startBrainServer } from '../src/serve/server.js';
import type { BrainServer } from '../src/serve/server.js';

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
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-agent-admin-shim-'));
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-agent-admin-'));
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

function adminToken(): string {
  return server.state.config().adminToken;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken()}`, ...extra };
}

function adminPost(p: string, body: unknown): Promise<Reply> {
  return request(port, {
    path: p,
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function pairAs(origin: string): Promise<{ token: string; clientId: string }> {
  const code = server.state.openPairing();
  const res = await request(port, {
    path: '/v1/pair',
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: formatPairingCode(code), client: { name: origin } }),
  });
  expect(res.status).toBe(200);
  const json = res.json<{ token: string; clientId: string }>();
  return { token: json.token, clientId: json.clientId };
}

function auth(origin: string, token: string, extra: Record<string, string> = {}) {
  return { origin, authorization: `Bearer ${token}`, ...extra };
}

async function adminWaitForPhase(isDone: (phase: string) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(port, { path: '/v1/admin/agent/status', headers: adminHeaders() });
    const run = res.json<{ run: { phase: string } | null }>().run;
    if (run && isDone(run.phase)) return run;
    if (Date.now() > deadline) throw new Error(`timed out; last run: ${JSON.stringify(run)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ADMIN_AGENT_ROUTES: Array<[string, string]> = [
  ['/v1/admin/agent/goal', 'POST'],
  ['/v1/admin/agent/status', 'GET'],
  ['/v1/admin/agent/approve', 'POST'],
  ['/v1/admin/agent/reject', 'POST'],
  ['/v1/admin/agent/stop', 'POST'],
];

describe('admin auth + origin policy', () => {
  it.each(ADMIN_AGENT_ROUTES)('%s %s is unreachable with an Origin header, even with the admin token', async (p, method) => {
    // origin:'absent' is what makes admin routes unreachable from ANY browser
    // context — a browser always sends Origin cross-origin, curl/CLI never do.
    const res = await request(port, {
      path: p,
      method,
      headers: adminHeaders({ origin: ORIGIN_A, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }),
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('forbidden_origin');
  });

  it.each(ADMIN_AGENT_ROUTES)('%s %s 401s without a token', async (p, method) => {
    const res = await request(port, {
      path: p,
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(401);
  });

  it('a paired CLIENT token is not an admin token', async () => {
    const { token } = await pairAs(ORIGIN_A);
    const res = await request(port, { path: '/v1/admin/agent/status', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/admin/agent/goal — client attribution', () => {
  it('409s when no extension is paired', async () => {
    const res = await adminPost('/v1/admin/agent/goal', { goal: 'summarize my inbox' });
    expect(res.status).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('no_client');
  });

  it('attributes to the sole paired client — the ordinary client route sees the run', async () => {
    const { token, clientId } = await pairAs(ORIGIN_A);
    const res = await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers', maxActions: 1 });
    expect(res.status).toBe(201);
    expect(res.json<{ clientId: string }>().clientId).toBe(clientId);

    // Attribution is the whole point: the paired extension's own status poll
    // must pick this run up as if the panel had submitted it.
    const status = await request(port, { path: '/v1/agent/status', headers: auth(ORIGIN_A, token) });
    const run = status.json<{ run: { clientId: string; goal: string } | null }>().run;
    expect(run).not.toBeNull();
    expect(run!.clientId).toBe(clientId);
    expect(run!.goal).toBe('find robotics engineers');
  });

  it('with two paired clients it refuses to guess', async () => {
    await pairAs(ORIGIN_A);
    await pairAs(ORIGIN_B);
    const res = await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers' });
    expect(res.status).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ambiguous_client');
  });

  it('an explicit client id resolves the ambiguity; an unknown one is rejected', async () => {
    const a = await pairAs(ORIGIN_A);
    await pairAs(ORIGIN_B);

    const bad = await adminPost('/v1/admin/agent/goal', { goal: 'g', client: 'cl_nope' });
    expect(bad.status).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('unknown_client');

    const ok = await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers', client: a.clientId });
    expect(ok.status).toBe(201);
    expect(ok.json<{ clientId: string }>().clientId).toBe(a.clientId);
  });

  it('409s while a run is already active', async () => {
    await pairAs(ORIGIN_A);
    await adminPost('/v1/admin/agent/goal', { goal: 'first goal' });
    const res = await adminPost('/v1/admin/agent/goal', { goal: 'second goal' });
    expect(res.status).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('run_active');
  });
});

describe('admin-driven lifecycle', () => {
  it('goal → approve → the CLIENT executes → terminal run readable via ?run=', async () => {
    const { token } = await pairAs(ORIGIN_A);
    const submitted = await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers', maxActions: 1 });
    const runId = submitted.json<{ runId: string }>().runId;

    const planned = await adminWaitForPhase((p) => p !== 'planning');
    expect(planned.phase).toBe('awaiting_approval');

    const approved = await adminPost('/v1/admin/agent/approve', { runId });
    expect(approved.json<{ run: { phase: string } }>().run.phase).toBe('running');

    // Play the extension over the ordinary client routes — admin never executes.
    const next1 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action1 = next1.json<{ action: { stepId: string; verb: string } }>().action;
    expect(action1.verb).toBe('navigate');
    await request(port, {
      path: '/v1/agent/action-result',
      method: 'POST',
      headers: auth(ORIGIN_A, token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runId, stepId: action1.stepId, verb: 'navigate', args: {}, result: { ok: true, summary: 'navigated' } }),
    });

    const next2 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action2 = next2.json<{ action: { stepId: string; verb: string } }>().action;
    expect(action2.verb).toBe('readResultCards');
    await request(port, {
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
          summary: 'read 1 card',
          cards: [{ cardIndex: 0, name: 'Ada Lovelace', headline: 'Robotics Engineer at Acme Robotics' }],
        },
      }),
    });

    const next3 = await request(port, { path: '/v1/agent/next-action', headers: auth(ORIGIN_A, token) });
    const action3 = next3.json<{ action: { stepId: string; verb: string } }>().action;
    expect(action3.verb).toBe('clickConnect');
    await request(port, {
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

    // Terminal runs are archived out of `active` immediately — ?run= must
    // still find it (this is how the eval runner reads a finished run).
    const byId = await request(port, {
      path: `/v1/admin/agent/status?run=${encodeURIComponent(runId)}`,
      headers: adminHeaders(),
    });
    const done = byId.json<{ run: { phase: string; history: unknown[] } | null }>().run;
    expect(done).not.toBeNull();
    expect(done!.phase).toBe('done');
    expect(done!.history).toHaveLength(3);

    // And the unfiltered admin status lists it under recent.
    const statusAll = await request(port, { path: '/v1/admin/agent/status', headers: adminHeaders() });
    const all = statusAll.json<{ run: unknown; recent: Array<{ id: string }> }>();
    expect(all.run).toBeNull();
    expect(all.recent.map((r) => r.id)).toContain(runId);
  });

  it('autoApprove goes straight to running with no approve call', async () => {
    await pairAs(ORIGIN_A);
    await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers', maxActions: 1, autoApprove: true });
    const run = await adminWaitForPhase((p) => p !== 'planning' && p !== 'awaiting_approval');
    expect(run.phase).toBe('running');
  });

  it('admin reject lands the run in stopped', async () => {
    await pairAs(ORIGIN_A);
    const submitted = await adminPost('/v1/admin/agent/goal', { goal: 'find robotics engineers' });
    const runId = submitted.json<{ runId: string }>().runId;
    await adminWaitForPhase((p) => p === 'awaiting_approval');

    const rejected = await adminPost('/v1/admin/agent/reject', { runId });
    expect(rejected.json<{ run: { phase: string } }>().run.phase).toBe('stopped');
  });

  it('admin stop is idempotent on unknown runs', async () => {
    const res = await adminPost('/v1/admin/agent/stop', { runId: 'run_does_not_exist' });
    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });
});
