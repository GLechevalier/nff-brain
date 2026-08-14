// Tier-0 tests for the fixture server — a FAKE driver played by the test over
// real HTTP (no browser, no extension).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtures, type FixtureHandle } from '../src/harness/fixtures.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18917 + Math.floor(Math.random() * 500);

let fx: FixtureHandle;

beforeAll(async () => {
  fx = await startFixtures({ evalsRoot, port: PORT });
});

afterAll(async () => {
  await fx.close();
});

describe('fixture server', () => {
  it('serves fixture pages and the instrumentation script, uncached', async () => {
    const page = await fetch(`${fx.baseUrl}/fixtures/pointer.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('/fixtures/bench.js');
    const js = await fetch(`${fx.baseUrl}/fixtures/bench.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('/bench/report');
  });

  it('refuses path traversal out of the fixtures dir', async () => {
    const res = await fetch(`${fx.baseUrl}/fixtures/..%2f..%2fpackage.json`);
    expect(res.status).toBe(404);
  });

  it('round-trips a command through a fake driver', async () => {
    const driverDone = (async () => {
      const res = await fetch(`${fx.baseUrl}/bench/poll?boot=fake1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cmdId: string; cmd: { kind: string } };
      expect(body.cmd.kind).toBe('ping');
      await fetch(`${fx.baseUrl}/bench/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmdId: body.cmdId, ok: true, data: { extVersion: 'fake' } }),
      });
    })();
    const result = await fx.sendCmd({ kind: 'ping' }, 5000);
    await driverDone;
    expect(result.ok).toBe(true);
    expect((result.data as { extVersion: string }).extVersion).toBe('fake');
  });

  it('retires an older loop when a newer boot polls', async () => {
    const oldPoll = fetch(`${fx.baseUrl}/bench/poll?boot=old`);
    await new Promise((r) => setTimeout(r, 100));
    expect(fx.driverLive()).toBe(true);
    const newPoll = fetch(`${fx.baseUrl}/bench/poll?boot=new`);
    const oldBody = (await (await oldPoll).json()) as { retire?: boolean };
    expect(oldBody.retire).toBe(true);
    // The new loop now holds the slot — a queued command reaches IT.
    const roundTrip = fx.sendCmd({ kind: 'ping' }, 5000);
    const newBody = (await (await newPoll).json()) as { cmdId: string; cmd: { kind: string } };
    expect(newBody.cmd.kind).toBe('ping');
    await fetch(`${fx.baseUrl}/bench/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmdId: newBody.cmdId, ok: true }),
    });
    expect((await roundTrip).ok).toBe(true);
  });

  it('ledgers page reports and answers waiters', async () => {
    const report = {
      run: 'nonce1',
      page: 'pointer.html',
      instance: 'i1',
      events: [{ t: 10, type: 'click', target: 'btn-left', isTrusted: true }],
      state: { rects: { 'btn-left': { x: 1, y: 2, w: 3, h: 4 } }, dblHandler: 0 },
    };
    const waiter = fx.ledger.waitForEvent('nonce1', (e) => e.type === 'click', 3000);
    const res = await fetch(`${fx.baseUrl}/bench/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(204);
    const ev = await waiter;
    expect(ev.target).toBe('btn-left');
    expect(fx.ledger.eventsFor('nonce1', 'pointer.html')).toHaveLength(1);
    expect(fx.ledger.eventsFor('other')).toHaveLength(0);
    expect(fx.ledger.lastState('nonce1', 'pointer.html')?.dblHandler).toBe(0);
  });

  it('logs download-asset requests with their run nonce', async () => {
    const res = await fetch(`${fx.baseUrl}/bench/dl/report.txt?run=nonce9`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('report.txt');
    expect(fx.ledger.assetRequests.some((r) => r.run === 'nonce9' && r.pathname.includes('report.txt'))).toBe(true);
  });

  it('reports driver liveness through loop-active', async () => {
    const res = await fetch(`${fx.baseUrl}/bench/loop-active`);
    const body = (await res.json()) as { active: boolean };
    expect(typeof body.active).toBe('boolean');
  });
});
