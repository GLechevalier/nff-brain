// LinkedIn label/heading classifiers — PURE (no DOM, no chrome.*). LinkedIn's
// DOM churns without notice; keeping the string logic here means rot shows up
// as a failing test naming the exact pattern, not as a silently dead recorder.

/** Is this the accessible label of an invitation send button? (en + fr —
 *  LinkedIn localizes these; the network path in src/inviteNet.ts is the
 *  locale-independent detector, this classifier is the note-carrying backup.) */
export function isSendInviteLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  return (
    l === 'send' ||
    l === 'send now' ||
    l === 'send invitation' ||
    l === 'send without a note' ||
    l.startsWith('send invitation to') ||
    // fr — deliberately NO bare 'envoyer': that is also the chat send button.
    l === 'envoyer maintenant' ||
    l === 'envoyer une invitation' ||
    l === 'envoyer sans note' ||
    l.startsWith('envoyer une invitation à')
  );
}

/**
 * Canonical profile URL from an href/location, or '' when it is not a
 * linkedin.com/in/ profile. String-prefix checks on purpose (no URL parsing):
 * keeps this file out of bundlePurity's hostname-reader pin.
 */
export function canonicalProfileUrl(href: string): string {
  const m = /^https:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/i.exec(href.trim());
  if (!m) return '';
  return `https://www.linkedin.com/in/${m[1]}`;
}

/** Pull the invitee's name out of a modal heading or button label. */
export function inviteeFromText(text: string): string {
  // "Invite Ada Lovelace to connect" · "Send invitation to Ada Lovelace" ·
  // "Invite Ada Lovelace to join your network" ·
  // fr "Inviter Ada Lovelace à rejoindre votre réseau"
  const m =
    /(?:inviter|invite|send invitation to)\s+(.{2,80}?)(?:\s+to connect|\s+to join your network|\s+à rejoindre votre réseau|\s*$)/i.exec(
      text.trim(),
    );
  return (m?.[1] ?? '').trim().slice(0, 80);
}

/**
 * The invitee's /in/ slug from a Connect button's preload href —
 * every LinkedIn Connect surface (main profile, browsemap sidebar, search)
 * renders an <a href="https://www.linkedin.com/preload/custom-invite/?vanityName=<slug>">,
 * which names the actual INVITEE locale-independently. '' when it is not such
 * a link. Regex on purpose (no URL parsing) — same bundlePurity posture as
 * canonicalProfileUrl above.
 */
/**
 * Is this element's componentkey LinkedIn's Connect button in its CONNECT
 * state? Search-result cards render Connect as an <a> WITHOUT the preload
 * href (its href is just the current page), but the componentkey
 * "ConnectButtonstate:invitation:urn:li:member:<id>_connect" still marks it,
 * locale-independently. The `_pending` state (click = withdraw) deliberately
 * does NOT match — a withdraw click must never park invitee identity.
 */
export function isConnectComponentKey(key: string): boolean {
  return /^ConnectButtonstate:invitation:.*_connect$/.test(key);
}

export function vanityFromPreloadHref(href: string): string {
  const m = /^https:\/\/(?:www\.)?linkedin\.com\/preload\/custom-invite\/\?(?:[^#]*&)?vanityName=([^&#]+)/i.exec(
    href.trim(),
  );
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).slice(0, 100);
  } catch {
    return '';
  }
}
