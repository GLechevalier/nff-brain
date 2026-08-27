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

/**
 * Called from deliverRecorderClip AFTER shouldCapture and the dedupe ring, so
 * the capture choke point and the once-per-person-per-day key both still
 * govern. Never throws; a no-op unless this is an invite-sent event and CRM
 * sync is configured + enabled.
 */
export async function maybeSyncCrmContact(msg: RecorderEventMsg): Promise<void> {
  if (msg.action !== 'linkedin.invite_sent') return;
  const cfg = await getCrmSync();
  if (!cfg?.enabled || !cfg.secret) return;
  const name = msg.fields.name;
  if (!name) return;

  const id = crypto.randomUUID();
  try {
    const res = await fetch(CRM_INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-ingest-token': cfg.secret },
      body: JSON.stringify({
        name,
        linkedin: msg.fields.linkedin || undefined,
        how_we_met: 'LinkedIn connection request',
        note_body: msg.fields.note || undefined,
        note_type: 'note',
        note_date: msg.at,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as { id?: string; created?: boolean };
    await appendActivity({
      id,
      url: CRM_INGEST_URL,
      title: out.created ? `CRM: added ${name}` : `CRM: already tracking ${name}`,
      text: `crm-sync ${msg.action}\nname: ${name}`,
      delivery: 'delivered',
    });
  } catch (err) {
    await appendActivity({
      id,
      url: CRM_INGEST_URL,
      title: `CRM: failed to add ${name}`,
      text: `crm-sync error: ${err instanceof Error ? err.message : String(err)}`,
      delivery: 'failed',
    });
  }
}
