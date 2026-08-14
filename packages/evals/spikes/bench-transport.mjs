// S0 transport spike (throwaway) — GO/NO-GO gate for the act-benchmark plan.
//
// Proves, with zero harness-side CDP:
//   1. the bench driver in a NFF_BRAIN_BENCH=1 build long-polls this server;
//   2. a `verb pointer.click` executed via chrome.debugger lands a real click
//      on a fixture page (nothing evicts the debugger — no CDP client exists);
//   3. after 90s of enforced idle, a new command still executes (long-poll /
//      alarm keepalive survives MV3 worker death).
//
// Run:  node packages/evals/spikes/bench-transport.mjs
// Needs: NFF_BRAIN_BENCH=1 NFF_BRAIN_TEST_MANIFEST=1 npm run build -w nff-brain-chrome
//        (the spike refuses to start on a non-bench dist)

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../chrome/dist');
const PROFILE = path.resolve(HERE, '../.profiles/act-bench-spike');
const PORT = 8917;
const POLL_HOLD_MS = 20_000;

// ── preflight ────────────────────────────────────────────────────────────────
const swjs = path.join(DIST, 'sw.js');
if (!fs.existsSync(swjs) || !fs.readFileSync(swjs, 'utf8').includes('__NFF_BENCH_DRIVER__')) {
  console.error('spike: dist/sw.js is not a bench build.');
  console.error('  PowerShell: $env:NFF_BRAIN_BENCH=\'1\'; $env:NFF_BRAIN_TEST_MANIFEST=\'1\'; npm run build -w nff-brain-chrome');
  process.exit(1);
}

function findChrome() {
  if (process.env.NFF_EVALS_CHROME) return process.env.NFF_EVALS_CHROME;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['PROGRAMFILES'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : ['/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('chrome.exe not found — set NFF_EVALS_CHROME');
}

// ── fixture page ─────────────────────────────────────────────────────────────
const SPIKE_HTML = `<!doctype html><meta charset="utf-8"><title>spike</title>
<style>#target{position:fixed;inset:0;font-size:40px}</style>
<button id="target">click me</button>
<script>
  const run = new URLSearchParams(location.search).get('run') || '';
  document.getElementById('target').addEventListener('click', (e) => {
    fetch('/bench/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run, page: 'spike.html', instance: 'spike', events: [{ t: Math.round(performance.now()), type: 'click', target: 'target', button: e.button, detail: e.detail, isTrusted: e.isTrusted }] }) });
  }, true);
</script>`;

// ── server state ─────────────────────────────────────────────────────────────
const queue = [];            // [{cmdId, cmd, resolve, reject}]
const inFlight = new Map();  // cmdId -> {resolve}
const reports = [];          // page event batches
const logs = [];
let newestBoot = null;
let heldPoll = null;         // {boot, res, timer}
let cmdSeq = 0;

function sendCmd(cmd) {
  const cmdId = `c${++cmdSeq}`;
  return new Promise((resolve) => {
    queue.push({ cmdId, cmd });
    inFlight.set(cmdId, { resolve });
    pump();
  });
}

function pump() {
  if (!heldPoll || queue.length === 0) return;
  const { res, timer } = heldPoll;
  clearTimeout(timer);
  heldPoll = null;
  const item = queue.shift();
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ cmdId: item.cmdId, cmd: item.cmd }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (u.pathname === '/bench/loop-active') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ active: heldPoll !== null }));
  } else if (u.pathname === '/bench/poll') {
    const boot = u.searchParams.get('boot') ?? '';
    if (newestBoot === null) newestBoot = boot;
    if (boot !== newestBoot) {
      // a newer loop exists (or this is an unknown stray) — retire it
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ retire: true }));
      return;
    }
    if (heldPoll) { clearTimeout(heldPoll.timer); heldPoll.res.writeHead(204, cors); heldPoll.res.end(); }
    const timer = setTimeout(() => { if (heldPoll?.res === res) { heldPoll = null; res.writeHead(204, cors); res.end(); } }, POLL_HOLD_MS);
    heldPoll = { boot, res, timer };
    res.on('close', () => { if (heldPoll?.res === res) { clearTimeout(heldPoll.timer); heldPoll = null; } });
    pump();
  } else if (u.pathname === '/bench/result') {
    const body = JSON.parse(await readBody(req));
    inFlight.get(body.cmdId)?.resolve(body);
    inFlight.delete(body.cmdId);
    res.writeHead(204, cors); res.end();
  } else if (u.pathname === '/bench/log') {
    const body = JSON.parse(await readBody(req));
    logs.push(body.line);
    console.log(`  [driver] ${body.line}`);
    res.writeHead(204, cors); res.end();
  } else if (u.pathname === '/bench/report') {
    const body = JSON.parse(await readBody(req));
    reports.push(body);
    console.log(`  [page] ${body.page} run=${body.run}: ${body.events.map((e) => e.type).join(',')}`);
    res.writeHead(204, cors); res.end();
  } else if (u.pathname === '/fixtures/spike.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(SPIKE_HTML);
  } else {
    res.writeHead(404); res.end();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
let chromeProc = null;
function killChrome() {
  if (!chromeProc) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /T /F /PID ${chromeProc.pid}`, { stdio: 'ignore' });
    else chromeProc.kill('SIGKILL');
  } catch { /* already gone */ }
  chromeProc = null;
}

try {
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  console.log(`spike: server on :${PORT}`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = findChrome();
  console.log(`spike: launching ${chrome}`);
  chromeProc = spawn(chrome, [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--silent-debugger-extension-api',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  // 1. driver hello
  await waitFor(() => logs.some((l) => l.includes('hello boot=')), 30_000, 'driver hello');
  console.log('PASS 1: driver hello arrived');

  const ping = await sendCmd({ kind: 'ping' });
  if (!ping.ok) throw new Error(`ping failed: ${ping.error}`);
  console.log(`PASS 1b: ping ok (ext v${ping.data?.extVersion})`);

  // 2. open fixture tab, attach, click via CDP
  const open = await sendCmd({ kind: 'openTab', url: `http://127.0.0.1:${PORT}/fixtures/spike.html?run=s0` });
  if (!open.ok) throw new Error(`openTab failed: ${open.error}`);
  const tabId = open.data.tabId;
  console.log(`  tab ${tabId} open`);
  const attach = await sendCmd({ kind: 'attach', tabId });
  if (!attach.ok) throw new Error(`attach failed: ${attach.error}`);
  const click = await sendCmd({ kind: 'verb', tabId, verb: { kind: 'pointer.click', target: { x: 300, y: 300 }, button: 'left', clickCount: 1 } });
  if (!click.ok || !click.data?.ok) throw new Error(`click failed: ${click.error ?? click.data?.resultText}`);
  console.log(`  engine: ${click.data.resultText}`);
  await waitFor(() => reports.some((r) => r.run === 's0' && r.events.some((e) => e.type === 'click')), 10_000, 'ledger click');
  const ev = reports.flatMap((r) => r.events).find((e) => e.type === 'click');
  console.log(`PASS 2: CDP click landed (isTrusted=${ev.isTrusted}, button=${ev.button}, detail=${ev.detail})`);

  // 3. enforced idle, then another command
  console.log('  idling 90s (worker may die; alarm/long-poll must revive it)…');
  await sleep(90_000);
  const t0 = Date.now();
  const ping2 = await Promise.race([
    sendCmd({ kind: 'ping' }),
    sleep(70_000).then(() => null),
  ]);
  if (!ping2 || !ping2.ok) throw new Error('post-idle ping did not come back within 70s');
  console.log(`PASS 3: post-idle ping ok after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('\nS0 SPIKE: GO — all three gates passed.');
} catch (err) {
  console.error(`\nS0 SPIKE: NO-GO — ${err.message}`);
  process.exitCode = 1;
} finally {
  killChrome();
  server.close();
}
