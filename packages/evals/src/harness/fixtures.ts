// The act-benchmark fixture server: one node:http server on loopback that is
// simultaneously (a) the static host for the instrumented fixture pages,
// (b) the bench driver's command channel (long-poll + result post — see
// packages/core/src/benchProtocol.ts for why the harness holds no CDP
// connection of its own), and (c) the ORACLE: fixture pages post every DOM
// event they see to /bench/report, and scenarios assert on the in-process
// ledger — the harness never evaluates JS on a page.
//
// Boot policy is newest-poll-wins: a poll from a new boot id retires the held
// poll of any older loop (answered {retire:true}, that loop exits). This is
// the server-side dedupe that lets the driver keep zero worker state.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BENCH_DEFAULT_PORT,
  BENCH_POLL_HOLD_MS,
  isBenchPageReport,
  type BenchCmd,
  type BenchCmdResult,
  type BenchPageEvent,
  type BenchPageReport,
} from '@nff-brain/core/benchProtocol';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
};

export interface AssetRequest {
  at: number;
  pathname: string;
  /** The ?run= nonce if the request carried one. */
  run: string;
}

export interface Ledger {
  reports: BenchPageReport[];
  /** All events for a run nonce, optionally narrowed to one page, in arrival order. */
  eventsFor(run: string, page?: string): BenchPageEvent[];
  /** The most recent page-defined state() summary for run+page, or null. */
  lastState(run: string, page: string): Record<string, unknown> | null;
  /** /bench/dl/* requests — the download oracle. */
  assetRequests: AssetRequest[];
  /** Resolves with the first (possibly already-arrived) event matching pred. */
  waitForEvent(run: string, pred: (e: BenchPageEvent) => boolean, timeoutMs: number): Promise<BenchPageEvent>;
}

export interface FixtureHandle {
  port: number;
  baseUrl: string;
  ledger: Ledger;
  /** Driver log lines, in arrival order. */
  logs: string[];
  /** True while a driver long-poll is currently held open. */
  driverLive(): boolean;
  waitForDriver(timeoutMs: number): Promise<void>;
  /** Queue a command for the driver and await its result. */
  sendCmd(cmd: BenchCmd, timeoutMs?: number): Promise<BenchCmdResult>;
  /** Forget ledger contents (between scenarios; asset log survives per-run filters anyway). */
  resetLedger(): void;
  close(): Promise<void>;
}

interface HeldPoll {
  boot: string;
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface PendingCmd {
  cmdId: string;
  cmd: BenchCmd;
}

export function fixturePort(): number {
  const raw = process.env.NFF_EVALS_FIXTURE_PORT;
  const n = raw ? Number(raw) : BENCH_DEFAULT_PORT;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`bad NFF_EVALS_FIXTURE_PORT: ${raw}`);
  return n;
}

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: Buffer) => {
      buf += c;
      if (buf.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

export async function startFixtures(opts: { evalsRoot: string; port?: number }): Promise<FixtureHandle> {
  const port = opts.port ?? fixturePort();
  const fixturesDir = path.join(opts.evalsRoot, 'fixtures');
  if (!fs.existsSync(fixturesDir)) throw new Error(`missing ${fixturesDir}`);

  const reports: BenchPageReport[] = [];
  const assetRequests: AssetRequest[] = [];
  const logs: string[] = [];
  const queue: PendingCmd[] = [];
  const inFlight = new Map<string, (r: BenchCmdResult) => void>();
  const eventWaiters: { run: string; pred: (e: BenchPageEvent) => boolean; resolve: (e: BenchPageEvent) => void }[] = [];
  let heldPoll: HeldPoll | null = null;
  let cmdSeq = 0;

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
  };

  function pump(): void {
    if (!heldPoll || queue.length === 0) return;
    const { res, timer } = heldPoll;
    clearTimeout(timer);
    heldPoll = null;
    const item = queue.shift()!;
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(item));
  }

  function notifyWaiters(report: BenchPageReport): void {
    for (const e of report.events) {
      for (let i = eventWaiters.length - 1; i >= 0; i--) {
        const w = eventWaiters[i]!;
        if (w.run === report.run && w.pred(e)) {
          eventWaiters.splice(i, 1);
          w.resolve(e);
        }
      }
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (u.pathname === '/bench/loop-active') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ active: heldPoll !== null }));
      return;
    }

    if (u.pathname === '/bench/poll') {
      const boot = u.searchParams.get('boot') ?? '';
      // Newest poll wins: retire whatever older loop currently holds the slot.
      if (heldPoll && heldPoll.boot !== boot) {
        clearTimeout(heldPoll.timer);
        heldPoll.res.writeHead(200, { 'content-type': 'application/json', ...cors });
        heldPoll.res.end(JSON.stringify({ retire: true }));
        heldPoll = null;
      } else if (heldPoll) {
        // Same boot polling twice (shouldn't happen) — release the old one empty.
        clearTimeout(heldPoll.timer);
        heldPoll.res.writeHead(204, cors);
        heldPoll.res.end();
        heldPoll = null;
      }
      const timer = setTimeout(() => {
        if (heldPoll?.res === res) {
          heldPoll = null;
          res.writeHead(204, cors);
          res.end();
        }
      }, BENCH_POLL_HOLD_MS);
      heldPoll = { boot, res, timer };
      res.on('close', () => {
        if (heldPoll?.res === res) {
          clearTimeout(heldPoll.timer);
          heldPoll = null;
        }
      });
      pump();
      return;
    }

    if (u.pathname === '/bench/result' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as BenchCmdResult;
      inFlight.get(body.cmdId)?.(body);
      inFlight.delete(body.cmdId);
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (u.pathname === '/bench/log' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { line?: string };
      if (typeof body.line === 'string') logs.push(body.line);
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (u.pathname === '/bench/report' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as unknown;
      if (isBenchPageReport(body)) {
        reports.push(body);
        notifyWaiters(body);
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (u.pathname.startsWith('/bench/dl/')) {
      const rel = u.pathname.slice('/bench/dl/'.length);
      const file = path.join(fixturesDir, 'dl', rel);
      if (!file.startsWith(path.join(fixturesDir, 'dl')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      assetRequests.push({ at: Date.now(), pathname: u.pathname, run: u.searchParams.get('run') ?? '' });
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${path.basename(file)}"`,
        'cache-control': 'no-store',
        ...cors,
      });
      res.end(fs.readFileSync(file));
      return;
    }

    if (u.pathname.startsWith('/fixtures/')) {
      const rel = u.pathname.slice('/fixtures/'.length);
      const file = path.join(fixturesDir, rel);
      if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(fs.readFileSync(file));
      return;
    }

    res.writeHead(404, cors);
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const ledger: Ledger = {
    reports,
    assetRequests,
    eventsFor(run, page) {
      return reports.filter((r) => r.run === run && (page === undefined || r.page === page)).flatMap((r) => r.events);
    },
    lastState(run, page) {
      for (let i = reports.length - 1; i >= 0; i--) {
        const r = reports[i]!;
        if (r.run === run && r.page === page && r.state) return r.state;
      }
      return null;
    },
    waitForEvent(run, pred, timeoutMs) {
      const existing = ledger.eventsFor(run).find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { run, pred, resolve };
        eventWaiters.push(waiter);
        setTimeout(() => {
          const i = eventWaiters.indexOf(waiter);
          if (i >= 0) {
            eventWaiters.splice(i, 1);
            reject(new Error(`timed out after ${timeoutMs}ms waiting for a page event`));
          }
        }, timeoutMs).unref();
      });
    },
  };

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    ledger,
    logs,
    driverLive: () => heldPoll !== null,
    async waitForDriver(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (heldPoll !== null) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`no bench-driver poll arrived within ${timeoutMs}ms — is the BENCH build loaded?`);
    },
    sendCmd(cmd, timeoutMs = 60_000) {
      const cmdId = `c${++cmdSeq}_${randomUUID().slice(0, 8)}`;
      return new Promise<BenchCmdResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          inFlight.delete(cmdId);
          reject(new Error(`bench cmd ${cmd.kind} (${cmdId}) got no result within ${timeoutMs}ms`));
        }, timeoutMs);
        inFlight.set(cmdId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        queue.push({ cmdId, cmd });
        pump();
      });
    },
    resetLedger() {
      reports.length = 0;
      assetRequests.length = 0;
    },
    close() {
      if (heldPoll) {
        clearTimeout(heldPoll.timer);
        try {
          heldPoll.res.writeHead(200, { 'content-type': 'application/json', ...cors });
          heldPoll.res.end(JSON.stringify({ retire: true }));
        } catch {
          /* socket already gone */
        }
        heldPoll = null;
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
