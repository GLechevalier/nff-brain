// Boots the REAL built CLI (`node packages/cli/dist/index.js serve`) as a
// subprocess on the fixed default port 7373 — the extension's hello walk scans
// from there, so a random port would never be discovered. State is isolated
// under state/brain-home via NFF_BRAIN_HOME (never by redirecting HOME, which
// would sever the spawned `claude` CLI's own auth in real-LLM tiers), and it
// PERSISTS across runner invocations on purpose: the extension's pairing token
// references this server's identity, so a fresh home every run would force a
// re-pair every run.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SERVE_PORT = 7373;

export interface ServeHandle {
  port: number;
  homeDir: string;
  adminToken: string;
  child: ChildProcess;
  admin<T>(p: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T>;
  stop(): Promise<void>;
}

export interface ServeOptions {
  evalsRoot: string;
  /** Absolute path to a fake `claude` binary (tier 2) — omitted = real claude. */
  claudeBin?: string;
}

function cliDistPath(evalsRoot: string): string {
  return path.resolve(evalsRoot, '..', 'cli', 'dist', 'index.js');
}

async function waitForHello(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/hello`, { signal: AbortSignal.timeout(1000) });
      const json = (await res.json()) as { ok?: boolean; name?: string };
      if (json.ok && json.name === 'nff-brain') return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`nff-brain serve did not answer on :${port} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startServe(opts: ServeOptions): Promise<ServeHandle> {
  const dist = cliDistPath(opts.evalsRoot);
  if (!fs.existsSync(dist)) {
    throw new Error(`missing ${dist} — run \`npm run build\` at the nff-brain root first`);
  }
  const homeDir = path.join(opts.evalsRoot, 'state', 'brain-home');
  fs.mkdirSync(homeDir, { recursive: true });

  const child = spawn(process.execPath, [dist, 'serve', '--port', String(SERVE_PORT), '--target', 'global', '--quiet'], {
    env: {
      ...process.env,
      NFF_BRAIN_HOME: homeDir,
      ...(opts.claudeBin ? { NFF_BRAIN_CLAUDE_BIN: opts.claudeBin } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[serve] ${d}`));

  try {
    await waitForHello(SERVE_PORT, 15_000);
  } catch (err) {
    child.kill();
    throw err;
  }

  const serveJson = path.join(homeDir, 'serve.json');
  const adminToken = (JSON.parse(fs.readFileSync(serveJson, 'utf8')) as { adminToken?: string }).adminToken ?? '';
  if (!adminToken) throw new Error(`no adminToken in ${serveJson}`);

  // node's fetch sends no Origin header — exactly what origin:'absent' routes demand.
  async function admin<T>(p: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
    const res = await fetch(`http://127.0.0.1:${SERVE_PORT}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || json.ok !== true) {
      throw new Error(`admin ${method} ${p} → ${res.status} ${json.message ?? ''}`.trim());
    }
    return json as T;
  }

  return {
    port: SERVE_PORT,
    homeDir,
    adminToken,
    child,
    admin,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        if (process.platform === 'win32' && child.pid) {
          // shell:false spawn, but kill the tree anyway — serve may spawn claude.
          spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
        setTimeout(() => resolve(), 3000).unref();
      });
    },
  };
}
