// CRM sync — LinkedIn invite → nff-admin contact ingest.
//
// One narrow job: when the passive LinkedIn recorder observes the user sending
// a connection invite, POST the invitee to nff-admin's CRM so the person is
// tracked. Opt-in twice over: the LinkedIn recorder must be enabled AND a
// shared ingest secret saved in Settings (which also grants the host
// permission). The secret has the same posture as the BYOK apiKey — inbound
// once, never re-displayed, PublicState carries booleans only.
//
// ponytail: fire-and-forget, no retry queue — a failed sync leaves a visible
// 'failed' activity row; upgrade path is the clipQueue/alarm pattern.

import { appendActivity } from './activity.js';
import { getCrmSync } from './storage.js';
import type { RecorderEventMsg } from './recorderTypes.js';

// The origin pattern (panel-safe) lives in protocol.ts — CRM_ORIGIN_PATTERN.
export const CRM_INGEST_URL = 'https://admin.nanoforgeflow.com/api/crm/contacts';
// Event ingest (invite accepted, message sent) — logs a crm_interactions row on
// the contact, creating them first-touch if unknown. See nff-admin ingestEvent.
export const CRM_EVENTS_URL = 'https://admin.nanoforgeflow.com/api/crm/events';
// Auth-only probe for the Settings "Test" button — token + permission verified
// server-side, nothing written.
export const CRM_PING_URL = 'https://admin.nanoforgeflow.com/api/crm/ping';

/**
 * One authenticated GET against an admin ping route. Shared by the CRM and
 * company-brain "Test" buttons. Never throws; the message is what the panel
 * shows verbatim (admin's `error` field when it sent one).
 */
export async function pingAdmin(url: string, header: string, value: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, { method: 'GET', headers: { [header]: value } });
    if (res.ok) return { ok: true, message: 'connected' };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : '';
    return { ok: false, message: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Settings "Test" for CRM sync: does the saved ingest secret get a 200? */
export async function testCrmSync(): Promise<{ ok: boolean; message: string }> {
  const cfg = await getCrmSync();
  if (!cfg?.secret) return { ok: false, message: 'no ingest secret saved' };
  return pingAdmin(CRM_PING_URL, 'x-crm-ingest-token', cfg.secret);
}

/** kind + interaction body for the two body-carrying LinkedIn events. */
const EVENT_KIND: Record<string, { kind: string; body: (f: Record<string, string>) => string }> = {
  'linkedin.invite_accepted': { kind: 'invite_accepted', body: () => 'Accepted your connection request' },
  'linkedin.message_sent': { kind: 'message_sent', body: (f) => f.message || 'Sent a LinkedIn message' },
};

/**
 * Called from deliverRecorderClip AFTER shouldCapture and the dedupe ring, so
 * the capture choke point and the dedupe key both still govern. Never throws;
 * a no-op unless this is a synced LinkedIn action and CRM sync is configured +
 * enabled. Invites create/upsert a contact (/contacts); accepts and messages
 * log an interaction on them (/events).
 */
export async function maybeSyncCrmContact(msg: RecorderEventMsg): Promise<void> {
  const cfg = await getCrmSync();
  if (!cfg?.enabled || !cfg.secret) return;
  const name = msg.fields.name;
  if (!name) return;

  const evt = EVENT_KIND[msg.action];
  if (evt) return syncCrmEvent(msg, name, evt.kind, evt.body(msg.fields), cfg.secret);
  if (msg.action !== 'linkedin.invite_sent') return;

  // Profile enrichment (net path scrapes the visible top card — recorder.ts):
  // role/company for the contact columns; headline+location live in the first
  // interaction note, since crm_contacts has no location column. An invite
  // note leads the note slot, with the profile snapshot kept beneath it — the
  // subtitle is recorded either way.
  await addCrmContact(msg.fields, msg.at, 'LinkedIn connection request', cfg.secret, `crm-sync ${msg.action}`);
}

/**
 * Create/upsert one CRM contact from recorder-shaped fields (name, linkedin,
 * role, company, headline, location, note). Shared by the passive invite path
 * above and the explicit right-click "Add to CRM" (crmMenu.ts). Never throws;
 * the outcome is an activity row + the boolean the caller flashes.
 */
export async function addCrmContact(
  f: Record<string, string>,
  at: string,
  howWeMet: string,
  secret: string,
  source: string,
): Promise<boolean> {
  const name = f.name;
  if (!name) return false;
  const snapshot = [f.headline, f.location].filter(Boolean).join(' · ');
  const noteBody = [f.note, snapshot].filter(Boolean).join('\n');
  const id = crypto.randomUUID();
  try {
    const res = await fetch(CRM_INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-ingest-token': secret },
      body: JSON.stringify({
        name,
        linkedin: f.linkedin || undefined,
        role: f.role || f.headline || undefined,
        company_name: f.company || undefined,
        how_we_met: howWeMet,
        note_body: noteBody || undefined,
        note_type: 'note',
        note_date: at,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as { id?: string; created?: boolean };
    await appendActivity({
      id,
      url: CRM_INGEST_URL,
      title: out.created ? `CRM: added ${name}` : `CRM: already tracking ${name}`,
      text: `${source}\nname: ${name}`,
      delivery: 'delivered',
    });
    return true;
  } catch (err) {
    await appendActivity({
      id,
      url: CRM_INGEST_URL,
      title: `CRM: failed to add ${name}`,
      text: `crm-sync error: ${err instanceof Error ? err.message : String(err)}`,
      delivery: 'failed',
    });
    return false;
  }
}

/** POST an interaction event (accept / message) to nff-admin's /api/crm/events.
 *  Same fire-and-forget posture as the invite path — a failure leaves a visible
 *  'failed' activity row, no retry queue. */
async function syncCrmEvent(
  msg: RecorderEventMsg,
  name: string,
  kind: string,
  body: string,
  secret: string,
): Promise<void> {
  const f = msg.fields;
  const verb = kind === 'invite_accepted' ? 'accepted' : 'messaged';
  const id = crypto.randomUUID();
  try {
    const res = await fetch(CRM_EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-ingest-token': secret },
      body: JSON.stringify({
        kind,
        name,
        linkedin: f.linkedin || undefined,
        role: f.role || f.headline || undefined,
        company_name: f.company || undefined,
        body,
        occurred_at: msg.at,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await appendActivity({
      id,
      url: CRM_EVENTS_URL,
      title: `CRM: ${verb} — ${name}`,
      text: `crm-sync ${msg.action}\nname: ${name}`,
      delivery: 'delivered',
    });
  } catch (err) {
    await appendActivity({
      id,
      url: CRM_EVENTS_URL,
      title: `CRM: failed ${verb} — ${name}`,
      text: `crm-sync error: ${err instanceof Error ? err.message : String(err)}`,
      delivery: 'failed',
    });
  }
}
