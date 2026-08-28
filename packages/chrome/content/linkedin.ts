// LinkedIn recorder: connection invites THE USER sends — who, when, and the
// note attached (the epic's literal item-4 example). Injected only after the
// user enabled the LinkedIn recorder and granted https://www.linkedin.com/*.
//
// The bright line, kept deliberately bright: this script reacts to the user
// CLICKING SEND on an invitation. It never reads profiles or feeds, never
// walks lists, and never automates anything. LinkedIn's DOM churns without
// notice, so detection leans on the send button's accessible label (aria-label
// / text), which is a product surface, not a styling artifact — and the
// classifiers are pure functions so selector rot is a test failure, not a
// mystery.

import { canonicalProfileUrl, inviteeFromText, isSendInviteLabel, vanityFromPreloadHref } from './linkedinClassify.js';
import { dayBucket, emit } from './runtime.js';

function findModalContext(button: Element): { name: string; note: string; linkedin: string } {
  // The send button lives inside the invite dialog; the dialog heading names
  // the invitee and its textarea holds the note. Fall back to the profile
  // page's top-card h1 when the flow skips the modal.
  const dialog = button.closest('[role="dialog"], .artdeco-modal') ?? document;
  const heading = dialog.querySelector('h1, h2, [id*="modal"] h2')?.textContent ?? '';
  let name = inviteeFromText(heading);
  if (!name) {
    const ariaLabel = button.getAttribute('aria-label') ?? '';
    name = inviteeFromText(ariaLabel);
  }
  if (!name && dialog === document) {
    name = document.querySelector('main h1')?.textContent?.trim().slice(0, 80) ?? '';
  }
  const note = dialog.querySelector('textarea')?.value.trim().slice(0, 280) ?? '';
  // Profile URL: a /in/ link inside the dialog, else the page itself when the
  // invite came from a profile page. Search/My Network sends have neither —
  // the field is honestly absent, never guessed.
  const profileLink = dialog.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
  const linkedin = canonicalProfileUrl(profileLink?.href ?? '') || canonicalProfileUrl(location.href);
  return { name, note, linkedin };
}

document.addEventListener(
  'click',
  (e) => {
    // composedPath() crosses open shadow roots; e.target retargets to the
    // shadow HOST, so closest() from it can never reach an in-shadow button
    // or anchor — the reason this path was dead on the current LinkedIn.
    const path = e.composedPath();

    // A Connect button (main profile, browsemap sidebar, search results) is an
    // <a> whose preload href names the INVITEE — the only honest identity when
    // the person invited is not the page's own profile. This emits a pending
    // CORRELATION record, not an invite: the SW records the invite only when
    // the voyager POST confirms it actually went out (see inviteNet.ts).
    for (const el of path) {
      if (!(el instanceof HTMLAnchorElement)) continue;
      const slug = vanityFromPreloadHref(el.href);
      if (!slug) continue;
      const name = inviteeFromText(el.getAttribute('aria-label') ?? '');
      emit({
        adapter: 'linkedin',
        action: 'linkedin.connect_click',
        // Slug in the key: distinct people on one page stay distinct in the
        // per-page dedupe Set; a double-fired click on one person collapses.
        key: `linkedin.connect_click:${slug}:${dayBucket()}`,
        title: name ? `Connect clicked: ${name}` : 'Connect clicked',
        // `slug` marks this as INVITEE identity (from the button's own href) —
        // modal-Send entries carry no slug, their linkedin is dialog-derived.
        fields: { slug, linkedin: `https://www.linkedin.com/in/${slug}`, ...(name && { name }) },
      });
      return;
    }

    let button: HTMLButtonElement | null = null;
    for (const el of path) {
      if (el instanceof HTMLButtonElement) {
        button = el;
        break;
      }
    }
    if (!button) return;
    const label = button.getAttribute('aria-label') ?? button.textContent ?? '';
    if (!isSendInviteLabel(label)) return;

    const { name, note, linkedin } = findModalContext(button);
    if (!name) return; // no honest name → no event; never guess

    // ALSO a correlation record, never a clip: emitting invite_sent here would
    // race the voyager confirmation for the dedupe-ring key and win with a
    // note-only event, dropping the enriched (headline/company) one. The net
    // path merges this entry's note into the confirmed invite instead.
    emit({
      adapter: 'linkedin',
      action: 'linkedin.connect_click',
      key: `linkedin.connect_click:${name}:${dayBucket()}`,
      title: `Connect clicked: ${name}`,
      fields: { name, ...(note && { note }), ...(linkedin && { linkedin }) },
    });
  },
  { capture: true },
);
