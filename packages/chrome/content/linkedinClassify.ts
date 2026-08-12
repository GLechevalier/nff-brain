// LinkedIn label/heading classifiers — PURE (no DOM, no chrome.*). LinkedIn's
// DOM churns without notice; keeping the string logic here means rot shows up
// as a failing test naming the exact pattern, not as a silently dead recorder.

/** Is this the accessible label of an invitation send button? */
export function isSendInviteLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  return (
    l === 'send' ||
    l === 'send now' ||
    l === 'send invitation' ||
    l === 'send without a note' ||
    l.startsWith('send invitation to')
  );
}

/** Pull the invitee's name out of a modal heading or button label. */
export function inviteeFromText(text: string): string {
  // "Invite Ada Lovelace to connect" · "Send invitation to Ada Lovelace"
  const m = /(?:invite|send invitation to)\s+(.{2,80}?)(?:\s+to connect|\s*$)/i.exec(text.trim());
  return (m?.[1] ?? '').trim().slice(0, 80);
}
