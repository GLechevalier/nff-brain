// Manual-mode chat's PAGE-action detector — a sibling to actionIntent.ts's
// navigate/history detector, kept in its own file rather than folded in
// because actionIntent.ts's header deliberately scopes itself to "go open
// this site" only. Same discipline: a cheap local heuristic, not an LLM
// call, zero chrome.*/node:* imports, only ever reads the user's own raw
// typed message.
//
// Unlike the navigate detector (which requires the ENTIRE remainder after
// the verb to collapse to one hostname-shaped token), a page action's
// target is naturally multi-word ("the Belgique button", "my email into the
// search box") — so this only requires the message to OPEN with one of a
// fixed set of interaction verbs (after stripping a polite lead-in), and
// hands the whole message through verbatim as the instruction for the CDP
// web agent to ground against the live page. That's a looser bar than the
// navigate detector's, so false positives ("check my email") are possible
// and accepted — same tradeoff philosophy actionIntent.ts's header
// documents for its own heuristic.

const POLITE_PREFIX_RE = /^(?:please|pls|could you|can you|would you|will you)\s+/i;

const PAGE_ACTION_VERBS = [
  'click',
  'tap',
  'press',
  'scroll',
  'type',
  'fill',
  'enter',
  'select',
  'choose',
  'check',
  'uncheck',
  'toggle',
  'drag',
  'submit',
  'expand',
  'collapse',
  'hover',
  'close',
  'dismiss',
  'pick',
];

const PAGE_ACTION_LEAD_RE = new RegExp(`^(?:${PAGE_ACTION_VERBS.join('|')})\\b`, 'i');

export interface PageActionIntent {
  /** The user's message verbatim — handed to the CDP web agent as its goal. */
  instruction: string;
}

/**
 * Detects an imperative "do something to the current page" message —
 * "click the X button", "scroll down", "type my email into the search box".
 * Only matches when the (politeness-stripped) message OPENS with a known
 * interaction verb, so plain questions that merely mention one in passing
 * ("what happens when I click submit?") are rejected.
 */
export function detectPageActionIntent(message: string): PageActionIntent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(POLITE_PREFIX_RE, '').trim();
  if (!PAGE_ACTION_LEAD_RE.test(stripped)) return null;
  return { instruction: trimmed };
}
