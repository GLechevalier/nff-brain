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

import { inviteeFromText, isSendInviteLabel } from './linkedinClassify.js';
import { dayBucket, emit } from './runtime.js';

function findModalContext(button: Element): { name: string; note: string } {
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
  return { name, note };
}

document.addEventListener(
  'click',
  (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button');
    if (!button) return;
    const label = button.getAttribute('aria-label') ?? button.textContent ?? '';
    if (!isSendInviteLabel(label)) return;

    const { name, note } = findModalContext(button);
    if (!name) return; // no honest name → no event; never guess

    emit({
      adapter: 'linkedin',
      action: 'linkedin.invite_sent',
      key: `linkedin.invite_sent:${name}:${dayBucket()}`,
      title: `Invited ${name} to connect`,
      fields: note ? { name, note } : { name },
    });
  },
  { capture: true },
);
