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
