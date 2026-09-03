// capturePageVisit: gate → per-URL dedupe → extract → honest-empty-skip →
// enqueue. The chrome.* / storage sides are mocked; recentKey/seenRecently/
// pushRecent run for REAL (imported from the actual activity.ts) so the
// dedupe assertions exercise the real ring logic, not a stub of it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getAllowlist,
  getCapture,
  getPageVisitSeen,
  setPageVisitSeen,
  getPairing,
  appendActivity,
  markDelivery,
  enqueuePageVisit,
  postClip,
  resolveBrainMode,
} = vi.hoisted(() => ({
  getAllowlist: vi.fn(async () => ({ rules: [{ host: 'docs.example.com', includeSubdomains: false, addedAt: '' }] })),
  getCapture: vi.fn(async () => ({ enabled: true, changedAt: '' })),
  getPageVisitSeen: vi.fn(async () => [] as { key: string; atMs: number }[]),
  setPageVisitSeen: vi.fn(async () => undefined),
  getPairing: vi.fn(async (): Promise<{ port: number; token: string } | null> => null),
  appendActivity: vi.fn(async () => []),
  markDelivery: vi.fn(async () => undefined),
  enqueuePageVisit: vi.fn(async () => true),
  postClip: vi.fn(async () => ({ ok: true as const, id: 'clp_srv_1', target: 'global' as const, pending: 1 })),
  resolveBrainMode: vi.fn(async (): Promise<'paired' | 'byok' | 'unconfigured'> => 'byok'),
}));

vi.mock('../src/storage.js', () => ({ getAllowlist, getCapture, getPageVisitSeen, setPageVisitSeen, getPairing }));
vi.mock('../src/standaloneDrain.js', () => ({ enqueuePageVisit }));
vi.mock('../src/client.js', () => ({ postClip }));
vi.mock('../src/mode.js', () => ({ resolveBrainMode }));
vi.mock('../src/activity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/activity.js')>();
  return { ...actual, appendActivity, markDelivery };
});

import { capturePageVisit } from '../src/pageVisitCapture.js';

const URL = 'https://docs.example.com/read';
const OFF_ALLOWLIST_URL = 'https://other.example.com/read';
const LOADED: { status?: string; url?: string } = { status: 'complete' };
const TAB = { url: URL, status: 'complete', title: 'Docs' };

function stubExecuteScript(result: unknown) {
  vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async () => [{ result }]) } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  getAllowlist.mockClear();
  getCapture.mockClear();
  getPageVisitSeen.mockReset().mockResolvedValue([]);
  setPageVisitSeen.mockClear();
  getPairing.mockReset().mockResolvedValue(null);
  appendActivity.mockClear();
  markDelivery.mockClear();
  enqueuePageVisit.mockClear();
  postClip.mockReset().mockResolvedValue({ ok: true, id: 'clp_srv_1', target: 'global', pending: 1 });
  resolveBrainMode.mockReset().mockResolvedValue('byok');
});

describe('capturePageVisit', () => {
  it('ignores a non-http(s) url', async () => {
    stubExecuteScript({ title: 't', text: 'x'.repeat(50) });
    await capturePageVisit(1, { status: 'complete' }, { url: 'chrome://extensions', status: 'complete' });
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('ignores an in-flight (not-yet-loaded) navigation', async () => {
    stubExecuteScript({ title: 't', text: 'x'.repeat(50) });
    await capturePageVisit(1, {}, { url: URL, status: 'loading' });
    expect(getCapture).not.toHaveBeenCalled();
  });

  it('stops at the gate when capture is disabled', async () => {
    getCapture.mockResolvedValueOnce({ enabled: false, changedAt: '' });
    stubExecuteScript({ title: 't', text: 'x'.repeat(50) });
    await capturePageVisit(1, LOADED, TAB);
    expect(enqueuePageVisit).not.toHaveBeenCalled();
  });

  it('stops at the gate when the site is not on the allowlist', async () => {
    stubExecuteScript({ title: 't', text: 'x'.repeat(50) });
    await capturePageVisit(1, LOADED, { ...TAB, url: OFF_ALLOWLIST_URL });
    expect(enqueuePageVisit).not.toHaveBeenCalled();
  });

  it('skips a url already captured within the dedupe window', async () => {
    getPageVisitSeen.mockResolvedValue([{ key: 'pagevisit|https://docs.example.com/read|', atMs: Date.now() }]);
    const exec = vi.fn();
    vi.stubGlobal('chrome', { scripting: { executeScript: exec } });
    await capturePageVisit(1, LOADED, TAB);
    expect(exec).not.toHaveBeenCalled();
    expect(enqueuePageVisit).not.toHaveBeenCalled();
  });

  it('silently no-ops when extraction throws (no host permission, restricted page, tab gone)', async () => {
    vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async () => { throw new Error('no access'); }) } });
    await expect(capturePageVisit(1, LOADED, TAB)).resolves.toBeUndefined();
    expect(enqueuePageVisit).not.toHaveBeenCalled();
    expect(setPageVisitSeen).toHaveBeenCalled(); // dedupe still recorded — one attempt per window
  });

  it('drops an honestly-empty extraction below the minimum length', async () => {
    stubExecuteScript({ title: 'Docs', text: 'too short' });
    await capturePageVisit(1, LOADED, TAB);
    expect(enqueuePageVisit).not.toHaveBeenCalled();
  });

  it('appends activity and enqueues on a real extraction', async () => {
    stubExecuteScript({ title: 'Docs Home', text: 'a'.repeat(500) });
    await capturePageVisit(1, LOADED, TAB);

    expect(setPageVisitSeen).toHaveBeenCalled();
    expect(appendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL, title: 'Docs Home', delivery: 'pending' }),
    );
    expect(enqueuePageVisit).toHaveBeenCalledWith(
      { text: 'a'.repeat(500), url: URL, title: 'Docs Home' },
      expect.any(String),
    );
  });

  it('falls back to the tab title when the page has no <title>', async () => {
    stubExecuteScript({ title: '', text: 'a'.repeat(500) });
    await capturePageVisit(1, LOADED, TAB);
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ title: 'Docs' }));
  });

  describe('paired mode', () => {
    it('POSTs to the local server instead of the local queue when paired', async () => {
      getPairing.mockResolvedValue({ port: 7373, token: 'tok' });
      resolveBrainMode.mockResolvedValue('paired');
      stubExecuteScript({ title: 'Docs Home', text: 'a'.repeat(500) });

      await capturePageVisit(1, LOADED, TAB);

      expect(postClip).toHaveBeenCalledWith(
        7373,
        'tok',
        expect.objectContaining({ kind: 'pagevisit', text: 'a'.repeat(500), url: URL, title: 'Docs Home' }),
      );
      expect(enqueuePageVisit).not.toHaveBeenCalled();
      expect(markDelivery).toHaveBeenCalledWith(expect.any(String), 'delivered', 'clp_srv_1');
    });

    it('still uses the local queue when paired but the mode preference is byok', async () => {
      getPairing.mockResolvedValue({ port: 7373, token: 'tok' });
      resolveBrainMode.mockResolvedValue('byok');
      stubExecuteScript({ title: 'Docs Home', text: 'a'.repeat(500) });

      await capturePageVisit(1, LOADED, TAB);

      expect(postClip).not.toHaveBeenCalled();
      expect(enqueuePageVisit).toHaveBeenCalled();
    });

    it('silently marks the activity row failed when the server POST throws — no error surfaced', async () => {
      getPairing.mockResolvedValue({ port: 7373, token: 'tok' });
      resolveBrainMode.mockResolvedValue('paired');
      postClip.mockRejectedValue(new Error('queue_reserved'));
      stubExecuteScript({ title: 'Docs Home', text: 'a'.repeat(500) });

      await expect(capturePageVisit(1, LOADED, TAB)).resolves.toBeUndefined();

      expect(markDelivery).toHaveBeenCalledWith(expect.any(String), 'failed');
      expect(enqueuePageVisit).not.toHaveBeenCalled();
    });
  });
});
