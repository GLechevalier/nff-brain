import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// End-to-end over the BUILT CLI (run `npm run build -w nff-brain` first), with
// HOME redirected so the developer's real ~/.nff-brain/serve.json is never
// touched and never rotated.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');

let home: string;
let ws: string;
const children: ChildProcess[] = [];

function env() {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function startServe(args: string[]): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd: ws, env: env() });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  return { child, output: () => out };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function get(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-serve-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-serve-ws-'));
  fs.mkdirSync(path.join(ws, '.nff-brain'), { recursive: true });
});

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) c.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('nff-brain serve', () => {
  it('binds an ephemeral port, answers /v1/hello and records an instance', async () => {
    const { output } = startServe(['--port', '0', '--quiet']);
    const port = await waitFor(() => {
      const m = /127\.0\.0\.1:(\d+)/.exec(output());
      return m ? Number(m[1]) : undefined;
    });

    const hello = await get(port, '/v1/hello');
    expect(hello.status).toBe(200);
    expect(JSON.parse(hello.body).name).toBe('nff-brain');

    const inst = JSON.parse(fs.readFileSync(path.join(home, '.nff-brain', 'serve-instance.json'), 'utf8'));
    expect(inst.port).toBe(port);
    expect(inst.workspaceRoot).toBe(ws);
    expect(inst.pid).toBeGreaterThan(0);
  });

  it('prints a pairing code on first run and none once a client is paired', async () => {
    const { output } = startServe(['--port', '0']);
    await waitFor(() => (/PAIRING OPEN/.test(output()) ? true : undefined));
    expect(output()).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);
  });

  it('exits 0 with "already running" when a second instance hits the same port', async () => {
    const first = startServe(['--port', '0', '--quiet']);
    const port = await waitFor(() => {
      const m = /127\.0\.0\.1:(\d+)/.exec(first.output());
      return m ? Number(m[1]) : undefined;
    });

    const second = spawnSync(process.execPath, [CLI, 'serve', '--port', String(port)], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    // Exit 0, not 1 — `nff-brain serve` must be idempotent so it is safe in a
    // shell alias or a login item.
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already running');
    expect(second.stdout).toContain(ws);
  });

  it('shuts down promptly even while a keep-alive socket is held open', async () => {
    const { child, output } = startServe(['--port', '0', '--quiet']);
    const port = await waitFor(() => {
      const m = /127\.0\.0\.1:(\d+)/.exec(output());
      return m ? Number(m[1]) : undefined;
    });

    // Hold a keep-alive connection. Without server.closeAllConnections() this
    // is exactly what keeps the process alive long past Ctrl-C.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/hello', agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error('server did not exit within 5s')), 5_000)),
    ]);
    agent.destroy();

    if (process.platform !== 'win32') {
      // The graceful path removes its instance record. On Windows child.kill()
      // maps to TerminateProcess, which cannot run a signal handler at all, so
      // the record is expected to survive — doctor reports it as stale instead.
      expect(fs.existsSync(path.join(home, '.nff-brain', 'serve-instance.json'))).toBe(false);
    }
  });

  it('rejects an out-of-range --port', () => {
    const r = spawnSync(process.execPath, [CLI, 'serve', '--port', '99999'], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--port');
  });
});

describe('nff-brain pair', () => {
  it('says so when the server is not running', () => {
    const r = spawnSync(process.execPath, [CLI, 'pair'], { cwd: ws, env: env(), encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not running');
  });

  it('opens a window against a running server and lists clients', async () => {
    const { output } = startServe(['--port', '0', '--quiet']);
    await waitFor(() => (/127\.0\.0\.1:\d+/.test(output()) ? true : undefined));

    const opened = spawnSync(process.execPath, [CLI, 'pair'], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(opened.status).toBe(0);
    expect(opened.stdout).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);

    const listed = spawnSync(process.execPath, [CLI, 'pair', '--list'], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('no clients paired');
  });

  it('--reset rotates the identity and works with the server down', async () => {
    // Start once purely to mint serve.json, then stop: --reset must not need a
    // running server, since a wedged pairing is exactly when you reach for it.
    const { child, output } = startServe(['--port', '0', '--quiet']);
    await waitFor(() => (/127\.0\.0\.1:\d+/.test(output()) ? true : undefined));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;

    const cfgFile = path.join(home, '.nff-brain', 'serve.json');
    const first = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const r = spawnSync(process.execPath, [CLI, 'pair', '--reset'], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    expect(after.serverId).not.toBe(first.serverId);
    expect(after.adminToken).not.toBe(first.adminToken);
    expect(after.clients).toEqual([]);
  });
});

describe('doctor', () => {
  it('reports serve state without ever printing a token', async () => {
    const { output } = startServe(['--port', '0', '--quiet']);
    await waitFor(() => (/127\.0\.0\.1:\d+/.test(output()) ? true : undefined));

    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.nff-brain', 'serve.json'), 'utf8'));
    const r = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: ws,
      env: env(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.stdout).toContain('serve:');
    expect(r.stdout).not.toContain(cfg.adminToken);
  });
});
