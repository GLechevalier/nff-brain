// CRM sync (src/crmSync.ts): gated on config, scoped to invite events, and
// never throws — a failed POST becomes a 'failed' activity row, nothing more.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecorderEventMsg } from '../src/recorderTypes.js';

const { getCrmSync, appendActivity } = vi.hoisted(() => ({
  getCrmSync: vi.fn<() => Promise<unknown>>(),
  appendActivity: vi.fn<(row: unknown) => Promise<unknown>>(async () => []),
}));
vi.mock('../src/storage.js', () => ({ getCrmSync }));
vi.mock('../src/activity.js', () => ({ appendActivity }));

import { CRM_EVENTS_URL, CRM_INGEST_URL, maybeSyncCrmContact } from '../src/crmSync.js';

const invite = (fields: Record<string, string>): RecorderEventMsg => ({
  type: 'recorderEvent',
  adapter: 'linkedin',
  action: 'linkedin.invite_sent',
  key: 'linkedin.invite_sent:Ada:2026-08-27',
  at: '2026-08-27T10:00:00.000Z',
  title: 'Invited Ada to connect',
  fields,
});

const cfg = { enabled: true, secret: 's3cret', addedAt: '2026-08-27T00:00:00.000Z' };

beforeEach(() => {
  vi.restoreAllMocks();
  getCrmSync.mockReset();
  appendActivity.mockReset();
});

describe('maybeSyncCrmContact', () => {
  it('does nothing when CRM sync is not configured or disabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(null);
    await maybeSyncCrmContact(invite({ name: 'Ada' }));
    getCrmSync.mockResolvedValue({ ...cfg, enabled: false });
    await maybeSyncCrmContact(invite({ name: 'Ada' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(appendActivity).not.toHaveBeenCalled();
  });

  it('ignores every action except linkedin.invite_sent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);
    await maybeSyncCrmContact({ ...invite({ name: 'Ada' }), action: 'github.issue_opened' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the contract payload with the secret header', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'c1', created: true }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);

    await maybeSyncCrmContact(
      invite({ name: 'Ada Lovelace', note: 'hello!', linkedin: 'https://www.linkedin.com/in/ada' }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CRM_INGEST_URL);
    expect((init.headers as Record<string, string>)['x-crm-ingest-token']).toBe('s3cret');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Ada Lovelace',
      linkedin: 'https://www.linkedin.com/in/ada',
      how_we_met: 'LinkedIn connection request',
      note_body: 'hello!',
      note_type: 'note',
      note_date: '2026-08-27T10:00:00.000Z',
    });
    expect(appendActivity).toHaveBeenCalledTimes(1);
    const row = appendActivity.mock.calls[0][0] as { title: string; delivery: string };
    expect(row.title).toBe('CRM: added Ada Lovelace');
    expect(row.delivery).toBe('delivered');
  });

  it('sends profile enrichment: role/company from the parsed headline, snapshot note with location', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: true }) }));
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);

    await maybeSyncCrmContact(
      invite({
        name: 'Ada Lovelace',
        linkedin: 'https://www.linkedin.com/in/ada',
        headline: 'Robotics Engineer at Acme Robotics',
        role: 'Robotics Engineer',
        company: 'Acme Robotics',
        location: 'Paris, Île-de-France, France',
      }),
    );

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Ada Lovelace',
      linkedin: 'https://www.linkedin.com/in/ada',
      role: 'Robotics Engineer',
      company_name: 'Acme Robotics',
      how_we_met: 'LinkedIn connection request',
      note_body: 'Robotics Engineer at Acme Robotics · Paris, Île-de-France, France',
      note_type: 'note',
      note_date: '2026-08-27T10:00:00.000Z',
    });
  });

  it('an explicit invite note leads the note slot, with the profile snapshot kept beneath', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: true }) }));
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);
    await maybeSyncCrmContact(invite({ name: 'Ada', note: 'hello!', headline: 'Engineer', location: 'Paris' }));
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.note_body).toBe('hello!\nEngineer · Paris'); // subtitle recorded even alongside a note
    expect(body.role).toBe('Engineer'); // headline fallback when no role field
  });

  it('reports an existing contact as already tracking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: false }) })));
    getCrmSync.mockResolvedValue(cfg);
    await maybeSyncCrmContact(invite({ name: 'Ada' }));
    const row = appendActivity.mock.calls[0][0] as { title: string };
    expect(row.title).toBe('CRM: already tracking Ada');
  });

  it('an accept posts kind=invite_accepted to /events with an interaction body', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: false, type: 'linkedin_accept' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);
    await maybeSyncCrmContact({
      ...invite({ name: 'Ada', linkedin: 'https://www.linkedin.com/in/ada' }),
      action: 'linkedin.invite_accepted',
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CRM_EVENTS_URL);
    expect(JSON.parse(init.body as string)).toMatchObject({
      kind: 'invite_accepted',
      name: 'Ada',
      linkedin: 'https://www.linkedin.com/in/ada',
      body: 'Accepted your connection request',
    });
    const row = appendActivity.mock.calls[0][0] as { title: string; delivery: string };
    expect(row.title).toBe('CRM: accepted — Ada');
    expect(row.delivery).toBe('delivered');
  });

  it('a message posts kind=message_sent with the message text as the body', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'c1', created: false, type: 'linkedin_message' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    getCrmSync.mockResolvedValue(cfg);
    await maybeSyncCrmContact({
      ...invite({ name: 'Ada', linkedin: 'https://www.linkedin.com/in/ada', message: 'thanks for connecting!' }),
      action: 'linkedin.message_sent',
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CRM_EVENTS_URL);
    expect(JSON.parse(init.body as string)).toMatchObject({ kind: 'message_sent', body: 'thanks for connecting!' });
    expect((appendActivity.mock.calls[0][0] as { title: string }).title).toBe('CRM: messaged — Ada');
  });

  it('never throws: HTTP errors and network failures become failed activity rows', async () => {
    getCrmSync.mockResolvedValue(cfg);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(maybeSyncCrmContact(invite({ name: 'Ada' }))).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    await expect(maybeSyncCrmContact(invite({ name: 'Ada' }))).resolves.toBeUndefined();
    expect(appendActivity).toHaveBeenCalledTimes(2);
    for (const call of appendActivity.mock.calls) {
      const row = call[0] as { title: string; delivery: string };
      expect(row.title).toBe('CRM: failed to add Ada');
      expect(row.delivery).toBe('failed');
    }
  });
});
