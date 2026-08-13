// Gmail / Calendar / Drive oracles over googleapis. Auth: OAuth2 desktop
// client + a refresh token minted once by `npm run setup:google` into
// .auth/google.json. No service account — consumer Gmail cannot delegate.
// googleapis is imported lazily so tier-0/1 runs never load ~40MB of SDK.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CalendarOracle, DriveOracle, GmailOracle, SeededMessage } from './types.js';

export interface GoogleAuthFile {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function googleAuthPath(evalsRoot: string): string {
  return path.join(evalsRoot, '.auth', 'google.json');
}

export function readGoogleAuth(evalsRoot: string): GoogleAuthFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(googleAuthPath(evalsRoot), 'utf8')) as Partial<GoogleAuthFile>;
    if (raw.clientId && raw.clientSecret && raw.refreshToken) return raw as GoogleAuthFile;
    return null;
  } catch {
    return null;
  }
}

async function oauthClient(auth: GoogleAuthFile): Promise<unknown> {
  const { google } = await import('googleapis');
  const client = new google.auth.OAuth2(auth.clientId, auth.clientSecret);
  client.setCredentials({ refresh_token: auth.refreshToken });
  return client;
}

function rfc822(msg: { from: string; subject: string; body: string }): string {
  // Gmail's insert wants base64url RFC822. `to` is the account itself — insert
  // never sends anything, it just materializes the message in the mailbox.
  const raw = [`From: ${msg.from}`, 'To: me', `Subject: ${msg.subject}`, '', msg.body].join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

export async function makeGmailOracle(auth: GoogleAuthFile): Promise<GmailOracle> {
  const { google } = await import('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: (await oauthClient(auth)) as never });

  async function labelId(name: string): Promise<string | null> {
    const res = await gmail.users.labels.list({ userId: 'me' });
    return res.data.labels?.find((l) => l.name === name)?.id ?? null;
  }

  async function subjectsOf(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of ids) {
      const m = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'] });
      const subject = m.data.payload?.headers?.find((h) => h.name === 'Subject')?.value;
      if (subject) out.push(subject);
    }
    return out;
  }

  return {
    async insertMessage(msg): Promise<SeededMessage> {
      const res = await gmail.users.messages.insert({
        userId: 'me',
        requestBody: { raw: rfc822(msg), labelIds: ['INBOX', 'UNREAD'] },
      });
      return { id: res.data.id ?? '', subject: msg.subject };
    },
    async listByLabel(labelName) {
      const id = await labelId(labelName);
      if (!id) return [];
      const res = await gmail.users.messages.list({ userId: 'me', labelIds: [id] });
      return (res.data.messages ?? []).map((m) => m.id ?? '').filter(Boolean);
    },
    async listDraftSubjects() {
      const res = await gmail.users.drafts.list({ userId: 'me' });
      const ids = (res.data.drafts ?? []).map((d) => d.message?.id ?? '').filter(Boolean);
      return subjectsOf(ids);
    },
    async listSentSubjects(afterEpochMs) {
      const q = `after:${Math.floor(afterEpochMs / 1000)}`;
      const res = await gmail.users.messages.list({ userId: 'me', labelIds: ['SENT'], q });
      return subjectsOf((res.data.messages ?? []).map((m) => m.id ?? '').filter(Boolean));
    },
    async listTrashedIds() {
      const res = await gmail.users.messages.list({ userId: 'me', labelIds: ['TRASH'] });
      return (res.data.messages ?? []).map((m) => m.id ?? '').filter(Boolean);
    },
    async deleteMessage(id) {
      await gmail.users.messages.delete({ userId: 'me', id }).catch(() => undefined);
    },
    async deleteLabel(labelName) {
      const id = await labelId(labelName);
      if (id) await gmail.users.labels.delete({ userId: 'me', id }).catch(() => undefined);
    },
  };
}

export async function makeCalendarOracle(auth: GoogleAuthFile): Promise<CalendarOracle> {
  const { google } = await import('googleapis');
  const cal = google.calendar({ version: 'v3', auth: (await oauthClient(auth)) as never });
  return {
    async insertEvent(ev) {
      const res = await cal.events.insert({
        calendarId: 'primary',
        requestBody: { summary: ev.summary, start: { dateTime: ev.startIso }, end: { dateTime: ev.endIso } },
      });
      return { id: res.data.id ?? '' };
    },
    async listEventSummaries(fromIso, toIso) {
      const res = await cal.events.list({ calendarId: 'primary', timeMin: fromIso, timeMax: toIso, singleEvents: true });
      return (res.data.items ?? []).map((e) => e.summary ?? '').filter(Boolean);
    },
    async deleteEvent(id) {
      await cal.events.delete({ calendarId: 'primary', eventId: id }).catch(() => undefined);
    },
  };
}

export async function makeDriveOracle(auth: GoogleAuthFile): Promise<DriveOracle> {
  const { google } = await import('googleapis');
  const drive = google.drive({ version: 'v3', auth: (await oauthClient(auth)) as never });
  return {
    async createFolder(name) {
      const res = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      return { id: res.data.id ?? '' };
    },
    async listFileNames(folderId) {
      const res = await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(name)' });
      return (res.data.files ?? []).map((f) => f.name ?? '').filter(Boolean);
    },
    async deleteFile(id) {
      await drive.files.delete({ fileId: id }).catch(() => undefined);
    },
  };
}
