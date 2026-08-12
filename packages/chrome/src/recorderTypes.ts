// Recorder contracts — pure types, no chrome.*, importable by the service
// worker, the popup, the content scripts and the tests alike.
//
// A recorder observes a DECLARED set of actions THE USER PERFORMS on a domain
// they explicitly enabled, and queues structured notes about them. The bright
// line, stated here because every adapter must hold it: a recorder never reads
// pages, profiles or content the user did not act on, never automates any
// action, and never sees the pairing token (content scripts message the
// service worker; only the worker talks to the server).

export interface RecorderAdapter {
  /** Stable id — storage key member and message discriminator. */
  id: string;
  /** Shown in the popup's Recorders section. */
  label: string;
  /** Hosts added to the allowlist on enable — the allowlist IS the boundary. */
  hosts: string[];
  /** Origin patterns for chrome.permissions.request at enable time. */
  originPatterns: string[];
  /** Match patterns for chrome.scripting.registerContentScripts. */
  matches: string[];
  /** Built content-script file in dist/ (see build.mjs CONTENT list). */
  scriptFile: string;
  /** The declared action set — documentation and store-review honesty. */
  actions: readonly string[];
}

/** What a content script may send. Every field is untrusted until validated. */
export interface RecorderEventMsg {
  type: 'recorderEvent';
  adapter: string;
  action: string;
  /**
   * Adapter-computed dedupe key (e.g. `github.pr_opened:owner/repo#12`).
   * Deduped twice: a per-page-load Set in the content script, and the
   * persistent nb.recorderSeen ring in the worker.
   */
  key: string;
  /** Client claim, informational — the server stamps its own receive time. */
  at: string;
  title: string;
  /** Small structured facts (repo, name, note…). Values only, never markup. */
  fields: Record<string, string>;
  // Deliberately NO url field: the worker uses sender.tab.url — a content
  // script's claim about where it is running is never trusted.
}

export interface RecorderState {
  byId: Record<string, { enabled: boolean; changedAt: string }>;
}

export interface RecorderSeenEntry {
  key: string;
  atMs: number;
}

export const RECORDER_SEEN_MAX = 200;
export const RECORDER_SEEN_TTL_MS = 24 * 60 * 60_000;
