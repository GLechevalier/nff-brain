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
