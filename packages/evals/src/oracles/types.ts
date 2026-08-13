// Oracle contracts — ground truth ALWAYS comes from a service's own API,
// never from the DOM the agent just manipulated. Each oracle is null when its
// credentials aren't configured; the runner then reports the scenario as
// `skipped-unconfigured` rather than failing it.

import type { WebAgentRun } from '@nff-brain/core';

export interface SeededMessage {
  id: string;
  subject: string;
}

export interface GmailOracle {
  /** Insert a message directly into the inbox (users.messages.insert — no send). */
  insertMessage(msg: { from: string; subject: string; body: string }): Promise<SeededMessage>;
  /** Message ids currently carrying the label (created on demand server-side). */
  listByLabel(labelName: string): Promise<string[]>;
  /** Subjects of drafts (safety: "no nonce in drafts"). */
  listDraftSubjects(): Promise<string[]>;
  /** Subjects in Sent (safety: "nothing actually sent"). */
  listSentSubjects(afterEpochMs: number): Promise<string[]>;
  /** Ids currently in Trash (safety: "nothing deleted"). */
  listTrashedIds(): Promise<string[]>;
  deleteMessage(id: string): Promise<void>;
  deleteLabel(labelName: string): Promise<void>;
}

export interface CalendarOracle {
  insertEvent(ev: { summary: string; startIso: string; endIso: string }): Promise<{ id: string }>;
  listEventSummaries(fromIso: string, toIso: string): Promise<string[]>;
  deleteEvent(id: string): Promise<void>;
}

export interface DriveOracle {
  createFolder(name: string): Promise<{ id: string }>;
  listFileNames(folderId: string): Promise<string[]>;
  deleteFile(id: string): Promise<void>;
}

export interface SlackOracle {
  /** Creates (or reuses) a channel and posts the seeded conversation. */
  createChannel(name: string): Promise<{ id: string }>;
  postMessage(channelId: string, text: string): Promise<{ ts: string }>;
  history(channelId: string, limit?: number): Promise<string[]>;
  archiveChannel(channelId: string): Promise<void>;
}

export interface NotionOracle {
  /** Creates a deal row in the configured Deals database. */
  createDeal(deal: { name: string; stage: string; amount: number; lastActivityIso?: string }): Promise<{ id: string }>;
  queryDealNames(): Promise<string[]>;
  archivePage(id: string): Promise<void>;
}

export interface NffCrmOracle {
  /** Seed/verify via the nff-admin CRM's MCP write tools (dev Supabase). */
  createContact(c: { name: string; email: string }): Promise<{ id: string }>;
  findContactByEmail(email: string): Promise<{ id: string; name: string } | null>;
  deleteContact(id: string): Promise<void>;
}

/**
 * LinkedIn has no API. The authoritative record of what the agent DID is the
 * run history serve kept; everything else is humanReview screenshots.
 */
export interface LinkedInOracle {
  connectedNames(run: WebAgentRun): string[];
  actionCount(run: WebAgentRun, verb: string): number;
}

export interface Oracles {
  gmail: GmailOracle | null;
  calendar: CalendarOracle | null;
  drive: DriveOracle | null;
  slack: SlackOracle | null;
  notion: NotionOracle | null;
  nffcrm: NffCrmOracle | null;
  linkedin: LinkedInOracle;
}

/** Which oracle a scenario's sites need, for the unconfigured-skip decision. */
export const ORACLE_BY_SITE: Record<string, keyof Oracles> = {
  gmail: 'gmail',
  gcal: 'calendar',
  gdrive: 'drive',
  slack: 'slack',
  notion: 'notion',
  nffcrm: 'nffcrm',
  linkedin: 'linkedin',
};
