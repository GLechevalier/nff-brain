// Locale-independent LinkedIn invite detection: watch the Voyager API request
// the page makes when an invitation is actually SENT, instead of classifying
// button labels. The DOM path (content/linkedin.ts) is defeated twice on the
// current LinkedIn: the invite modal renders inside shadow DOM (click targets
// retarget to the host, querySelector can't reach in), and its labels are
// localized ("Envoyer sans note" never matches an English classifier). The
// network shape is identical in every locale and observed from the service
// worker, so stale/orphaned tabs can't lose events either.
//
// PURE module — no chrome.*, no fetch. The webRequest listener lives in sw.ts;
// the handler in recorder.ts.

/**
 * Is this request the page sending a connection invitation?
 * Broad on purpose (LinkedIn renames these endpoints without notice):
 * a successful POST to a voyager endpoint that names invitations, minus the
 * verbs that are ABOUT invitations but are not you sending one.
 * ponytail: pattern-matched, not pinned to one endpoint — if an invite ever
 * stops syncing, the SW's console.debug of unmatched voyager POSTs names the
 * real URL to add here.
 */
export function classifyInviteRequest(method: string, url: string, statusCode: number): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  if (statusCode < 200 || statusCode >= 300) return false;
  if (!url.startsWith('https://www.linkedin.com/voyager/api/')) return false;
  if (!/invitation/i.test(url)) return false;
  // Not-you-inviting verbs: withdrawing your own, acting on someone else's,
  // or the badge/summary bookkeeping around the invitations page.
  if (/withdraw|accept|ignore|reject|closeInvitations|invitationsSummary|seenReceived/i.test(url)) return false;
  return true;
}

/**
 * The invitee's name from the profile tab's title — "Merchrist K. | LinkedIn"
 * in every locale, with an optional "(3) " unread prefix. Only meaningful on a
 * /in/ profile page; the caller gates on that. '' = no honest name.
 */
export function nameFromTabTitle(title: string): string {
  const t = title.replace(/^\(\d+\)\s*/, '').trim();
  const m = /^(.{2,80}?)\s*\|\s*LinkedIn$/i.exec(t);
  return (m?.[1] ?? '').trim().slice(0, 80);
}

/** Same day-granularity bucket the content-script emitter uses, so the
 *  nb.recorderSeen ring dedupes the two detection paths against each other. */
export function dayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── pending invite correlation (nb.invitePending) ───────────────────────────
// Clicks carry data the voyager POST above cannot see: a Connect-button click
// names the INVITEE (content/linkedin.ts reads the button's preload href +
// aria-label), and a modal-Send click carries the typed NOTE. Neither click is
// an invite by itself — the POST is what confirms one went out. These pure
// helpers hold the clicks' data until the POST consumes the per-field MERGE:
// the fix for browsemap/search/My-Network misattribution AND for the note
// being lost on the network path.

export interface PendingInvite {
  tabId: number;
  /** '' when no click named the person (e.g. unparsed locale). A SLUG-bearing
   *  entry without a name makes the consumer SKIP the invite, rather than
   *  misattribute it to the tab. */
  name: string;
  linkedin: string;
  /** The invitee's /in/ slug (Connect-button clicks only) — routes the profile
   *  scrape's voyager-blob matcher to the invitee instead of the page's own
   *  profile. '' for modal-Send entries: identity falls back to the tab. */
  slug: string;
  /** The invite note typed in the modal (modal-Send clicks only). */
  note: string;
  atMs: number;
}

export const PENDING_INVITE_TTL_MS = 60_000;
export const PENDING_INVITE_MAX = 20;

/** TTL-filter + append + cap. */
export function pushPendingInvite(
  list: readonly PendingInvite[],
  entry: PendingInvite,
  nowMs: number,
): PendingInvite[] {
  const fresh = list.filter((p) => nowMs - p.atMs < PENDING_INVITE_TTL_MS);
  fresh.push(entry);
  return fresh.slice(-PENDING_INVITE_MAX);
}

/**
 * Consume for one tab: the tab's fresh entries MERGE per-field (newest
 * non-empty wins) and the tab's whole queue is dropped from `rest`. The merge
 * is what joins a Connect click (slug/linkedin) with the modal-Send click that
 * follows it (name/note) into one invitee record. ponytail: newest-wins per
 * field, not FIFO — a cancelled invite modal leaves an orphan older entry, and
 * FIFO would hand that orphan to the next real invite (the exact
 * misattribution this store exists to fix); two genuinely simultaneous
 * in-flight invite POSTs from one tab would need two clicks within one network
 * RTT, which a human cannot do. Known merge ceiling, accepted: cancel B's
 * modal then immediately invite C from the same tab inside the TTL and B's
 * leftover note can ride along on C's invite.
 */
export function takePendingInvite(
  list: readonly PendingInvite[],
  tabId: number,
  nowMs: number,
): { entry: PendingInvite | null; rest: PendingInvite[] } {
  const fresh = list.filter((p) => nowMs - p.atMs < PENDING_INVITE_TTL_MS);
  const mine = fresh.filter((p) => p.tabId === tabId);
  let entry: PendingInvite | null = null;
  for (const p of mine) {
    entry = entry
      ? {
          tabId,
          name: p.name || entry.name,
          linkedin: p.linkedin || entry.linkedin,
          slug: p.slug || entry.slug,
          note: p.note || entry.note,
          atMs: p.atMs,
        }
      : p;
  }
  return { entry, rest: fresh.filter((p) => p.tabId !== tabId) };
}

// ── the MAIN-world network tap (rec-linkedin-net.js) ────────────────────────
// The tap wraps window.fetch/XHR in the page's own world and postMessages a
// compact summary of every voyager call it sees. content/linkedin.ts forwards
// it to the SW (message type 'linkedinNet'); onLinkedinNet in recorder.ts uses
// these PURE classifiers to turn the summary into records. Two facts that the
// invite webRequest path cannot see live in bodies: the text of a message you
// send (request body) and who just accepted you (a connections response body).

/** What the tap forwards. Bodies present only for the shortlisted endpoints. */
export interface NetTapPayload {
  url: string;
  method: string;
  status: number;
  /** Request body text — messaging createMessage only, clamped by the tap. */
  reqBody?: string;
  /** Response body text — RECENTLY_ADDED connections only, clamped by the tap. */
  resBody?: string;
  /** Recipient scraped from the messaging thread DOM (content-side), when one. */
  recipientName?: string;
  recipientLinkedin?: string;
}

/** Path (no host, no query) — for the local net-log. Regex, never new URL (the
 *  bundlePurity .hostname pin). */
export function endpointOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(0, 200);
}

/** Is this the page POSTing a chat message you typed? */
export function classifyMessageSend(method: string, url: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  if (!url.startsWith('https://www.linkedin.com/voyager/api/')) return false;
  if (!/messaging|messenger/i.test(url)) return false;
  // The send action across LinkedIn's messaging API renames: createMessage
  // (GraphQL messengerMessages) and the older eventCreate. Both name "message".
  return /createMessage|messengerMessages|\/events\b|messagesbyanchor/i.test(url);
}

/** Does this response carry the "recently added connections" list (accepts)? */
export function isRecentConnectionsResponse(url: string): boolean {
  return (
    url.startsWith('https://www.linkedin.com/voyager/api/') &&
    /connections/i.test(url) &&
    /RECENTLY_ADDED/i.test(url)
  );
}

/**
 * The message text from a createMessage request body. Tolerant: LinkedIn's
 * messaging payload shape drifts, so this walks the parsed JSON for the first
 * plausible `body`/`text` string under a message-ish key. '' on any miss —
 * the caller keeps the local net-log entry and skips CRM.
 */
export function parseMessageText(reqBody: string | undefined): string {
  if (!reqBody) return '';
  let root: unknown;
  try {
    root = JSON.parse(reqBody);
  } catch {
    return '';
  }
  const seen = new Set<unknown>();
  const walk = (v: unknown): string => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return '';
    seen.add(v);
    const o = v as Record<string, unknown>;
    // The common shapes: {message:{body:{text}}}, {body:{text}}, {body:'…'}.
    const body = o.body;
    if (typeof body === 'string' && body.trim()) return body.trim();
    if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).text === 'string') {
      const t = (body as Record<string, unknown>).text as string;
      if (t.trim()) return t.trim();
    }
    for (const val of Object.values(o)) {
      const found = walk(val);
      if (found) return found;
    }
    return '';
  };
  return walk(root).slice(0, 2000);
}

/** One newly-accepted connection pulled from a RECENTLY_ADDED response. */
export interface AcceptedConnection {
  slug: string;
  name: string;
}

/**
 * Every connection profile named in a RECENTLY_ADDED response body. Tolerant:
 * walks the parsed JSON for objects carrying a publicIdentifier plus a name,
 * whatever nesting LinkedIn currently uses. [] on parse/shape miss (the SW
 * breadcrumbs it). Dedupe/baseline/first-run handling is the SW's job — this is
 * pure extraction only.
 */
export function classifyAcceptedFromResponse(url: string, resBody: string | undefined): AcceptedConnection[] {
  if (!isRecentConnectionsResponse(url) || !resBody) return [];
  let root: unknown;
  try {
    root = JSON.parse(resBody);
  } catch {
    return [];
  }
  const out = new Map<string, string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    const o = v as Record<string, unknown>;
    const slug = typeof o.publicIdentifier === 'string' ? o.publicIdentifier : '';
    if (slug) {
      const first = typeof o.firstName === 'string' ? o.firstName : '';
      const last = typeof o.lastName === 'string' ? o.lastName : '';
      const named =
        [first, last].filter(Boolean).join(' ').trim() ||
        (typeof o.name === 'string' ? o.name.trim() : '');
      if (named && !out.has(slug)) out.set(slug, named.slice(0, 80));
    }
    for (const val of Object.values(o)) walk(val);
  };
  walk(root);
  return [...out].map(([slug, name]) => ({ slug, name }));
}

// ── local net-log ring (nb.netLog) — every voyager call, metadata only ──────
// "Nothing is invisible": each tapped call leaves a lightweight local record so
// an un-classified endpoint is still visible and a future classifier is a
// one-liner away. Metadata only — no bodies persisted. Surfaced nowhere yet.

export interface NetLogEntry {
  atMs: number;
  method: string;
  endpoint: string;
  status: number;
}

export const NETLOG_MAX = 300;

export function pushNetLog(list: readonly NetLogEntry[], entry: NetLogEntry): NetLogEntry[] {
  return [...list, entry].slice(-NETLOG_MAX);
}

// ── accept dedupe (nb.acceptSeen) — slug → first-seen ms, 30-day ────────────
// A person stays in RECENTLY_ADDED for days, so a 24h ring is not enough. This
// map is the authoritative accept dedupe; the SW also uses "empty map = first
// run" to baseline existing connections silently (only accepts AFTER you turn
// tracking on are reported — "who accepted you RECENTLY").

export const ACCEPT_SEEN_TTL_MS = 30 * 24 * 60 * 60_000;

export function acceptSeenHas(map: Readonly<Record<string, number>>, slug: string, nowMs: number): boolean {
  const at = map[slug];
  return at !== undefined && nowMs - at < ACCEPT_SEEN_TTL_MS;
}

/** Add slug and prune expired entries (keeps the map from growing forever). */
export function acceptSeenPut(
  map: Readonly<Record<string, number>>,
  slug: string,
  nowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, at] of Object.entries(map)) {
    if (nowMs - at < ACCEPT_SEEN_TTL_MS) next[k] = at;
  }
  next[slug] = nowMs;
  return next;
}
