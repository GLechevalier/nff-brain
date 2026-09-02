// Right-click "Add to CRM" (src/crmMenu.ts): target resolution is honest
// (link beats page, non-profile = null) and the click path POSTs the scraped
// person without going through the recorder toggle / allowlist / dedupe ring.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCrmSync, getCapture, appendActivity } = vi.hoisted(() => ({
  getCrmSync: vi.fn<() => Promise<unknown>>(),
  getCapture: vi.fn(async () => ({ enabled: true })),
  appendActivity: vi.fn<(row: unknown) => Promise<unknown>>(async () => []),
}));
vi.mock('../src/storage.js', () => ({ getCrmSync, getCapture }));
vi.mock('../src/activity.js', () => ({ appendActivity }));
vi.mock('../src/badge.js', () => ({ flashCaptured: vi.fn(), paintBadge: vi.fn() }));
vi.mock('../src/connection.js', () => ({ currentPhase: vi.fn(async () => 'connected') }));

import { CRM_INGEST_URL } from '../src/crmSync.js';
import { CRM_MENU_ITEM, crmTarget, MENU_ID_CRM, onCrmMenuClicked } from '../src/crmMenu.js';

const PAGE = 'https://www.linkedin.com/in/ada-lovelace/';
const click = (linkUrl?: string) =>
  ({ menuItemId: MENU_ID_CRM, linkUrl, editable: false, pageUrl: PAGE }) as chrome.contextMenus.OnClickData;
const tab = { id: 7, url: PAGE, title: '(3) Ada Lovelace | LinkedIn' } as chrome.tabs.Tab;

beforeEach(() => {
  vi.restoreAllMocks();
  getCrmSync.mockReset();
  appendActivity.mockReset();
});

describe('crmTarget', () => {
  it('uses the page profile when nothing else is clicked', () => {
    expect(crmTarget(undefined, PAGE)).toEqual({ linkedin: 'https://www.linkedin.com/in/ada-lovelace', inviteeSlug: '' });
  });
  it('a right-clicked /in/ link wins and carries its slug for the scrape', () => {
    expect(crmTarget('https://www.linkedin.com/in/grace-hopper?x=1', PAGE)).toEqual({
      linkedin: 'https://www.linkedin.com/in/grace-hopper',
      inviteeSlug: 'grace-hopper',
    });
  });
  it('never guesses off the feed or a non-profile link', () => {
    expect(crmTarget('https://www.linkedin.com/company/acme', 'https://www.linkedin.com/feed/')).toBeNull();
  });
});

describe('onCrmMenuClicked', () => {
  it('is linkedin-only and ignores the remember verbs', async () => {
    expect(CRM_MENU_ITEM.documentUrlPatterns).toContain('https://www.linkedin.com/*');
    await onCrmMenuClicked({ ...click(), menuItemId: 'nb.remember' }, tab);
    expect(getCrmSync).not.toHaveBeenCalled();
  });

  it('POSTs the scraped person with the secret, bypassing the enabled toggle', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: true }) }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async () => [
          { result: { name: 'Ada Lovelace', headline: 'Engineer at Analytical', location: 'London' } },
        ]),
      },
    });
    getCrmSync.mockResolvedValue({ enabled: false, secret: 's3cret' });

    await onCrmMenuClicked(click(), tab);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CRM_INGEST_URL);
    expect((init.headers as Record<string, string>)['x-crm-ingest-token']).toBe('s3cret');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'Ada Lovelace',
      linkedin: 'https://www.linkedin.com/in/ada-lovelace',
      role: 'Engineer',
      company_name: 'Analytical',
      how_we_met: 'LinkedIn (added from right-click)',
    });
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ title: 'CRM: added Ada Lovelace', delivery: 'delivered' }));
  });

  it('falls back to the tab title when the scrape fails, and fails honestly without a secret', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: false }) }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async () => { throw new Error('no access'); }) } });
    getCrmSync.mockResolvedValue({ enabled: true, secret: 's3cret' });
    await onCrmMenuClicked(click(), tab);
    expect(JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).name).toBe('Ada Lovelace');

    fetchSpy.mockClear();
    getCrmSync.mockResolvedValue(null);
    await onCrmMenuClicked(click(), tab);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appendActivity).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'CRM: not configured', delivery: 'failed' }));
  });
});
