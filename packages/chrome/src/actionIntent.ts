// Manual-mode chat's action-intent detector — a cheap local heuristic, not an
// LLM call, so it costs nothing extra on every ordinary chat message. Zero
// chrome.*/node:* imports, same testability discipline as gate.ts.
//
// Deliberately narrow: only simple "go open this site" intents are detected
// here. A richer goal ("connect with 5 people in DevRel") still belongs to
// the existing Plan/Auto mode pipeline (buildPlanPrompt/parsePlanResponse),
// which this file does not touch.
//
// Two tiers: a registered AGENT_ADAPTERS alias (today, just LinkedIn — this
// path is unchanged and stays first) wins when present, since that site may
// also have real DOM-automation behind it. Everything else falls to a
// generic host guess — ONLY ever reading the user's own raw typed message,
// never chat history/notes/LLM output, so a hostile note can never steer
// where this navigates (only the false-positive rate on ordinary sentences
// is a concern here, not an untrusted-content trust boundary).

import { AGENT_ADAPTERS } from './agentRegistry.js';
import type { AgentAdapter } from './agentTypes.js';

export type ActionIntent =
  | { kind: 'adapter'; adapterId: string; label: string; url: string }
  | { kind: 'host'; host: string; label: string; url: string }
  | { kind: 'history'; direction: 'back' | 'forward' };

const ACTION_VERBS = ['navigate', 'go to', 'open', 'visit', 'take me to'];

/** The first host's leading label, e.g. "linkedin" from "www.linkedin.com". */
function adapterAlias(adapter: AgentAdapter): string | null {
  const host = adapter.hosts[0];
  if (!host) return null;
  const label = host.replace(/^www\./, '').split('.')[0];
  return label || null;
}

// Verb + optional "to" + the rest of the message. Kept separate from
// ACTION_VERBS (which mixes single words and phrases for the substring
// presence check below) — "take me" here plus an optional trailing "to"
// covers "take me to X" the same way "go"+"to" covers "go to X".
const GENERIC_TAIL_RE = /\b(?:navigate|go|open|visit|take\s+me)\b\s*(?:to\b)?\s+(.+)$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// Common conversational sign-offs stripped from the tail before the
// single-token hostname check — "pls"/"thanks"/etc. would otherwise make an
// otherwise-clean request look like a multi-word (rejected) sentence.
// `(?:^|\s+)` rather than a bare `\s+` prefix: extractHistoryDirection's
// remainder can be the filler word alone ("go back please" leaves just
// "please", no leading whitespace once the outer regex's \s* already ate it).
const TRAILING_FILLER_RE = /(?:^|\s+)(?:pl(?:ease|s|z)|now|for me|thanks?(?:\s+you)?|thank\s+you|ok(?:ay)?|asap)$/i;
// "navigate to a reddit" / "go to the whitehouse" — a leading article is as
// much conversational noise as a trailing "pls"; strip it before requiring
// the remainder to collapse to one token.
const LEADING_ARTICLE_RE = /^(?:a|an|the)\s+/i;

/** Chained sign-offs ("google now please") lose one filler per pass. */
function stripFillers(s: string): string {
  let rest = s;
  let stripped = rest;
  do {
    rest = stripped;
    stripped = rest.replace(TRAILING_FILLER_RE, '').replace(/[.?!]+$/, '').trim();
  } while (stripped !== rest);
  return rest;
}

/**
 * Requires the ENTIRE remainder after the verb (once trailing filler/
 * punctuation is stripped) to collapse to exactly one hostname-shaped token —
 * "open the pod bay doors" leaves "the pod bay doors" (four words) and is
 * rejected, same as "navigate to the settings page". This is what keeps an
 * ordinary sentence that merely contains "open"/"visit" from being misread as
 * a navigate request. A single token with a dot is used as a literal domain;
 * without one, ".com" is appended as a blunt but broadly-correct default for
 * bare brand names ("google" → "google.com").
 */
function extractGenericSite(message: string): { host: string; url: string } | null {
  const m = GENERIC_TAIL_RE.exec(message.trim());
  if (!m) return null;
  let rest = m[1].trim().replace(/[.?!]+$/, '').trim();
  rest = rest.replace(LEADING_ARTICLE_RE, '').trim();
  rest = stripFillers(rest);
  if (!rest || /\s/.test(rest)) return null;
  const candidate = rest.toLowerCase();
  if (!HOSTNAME_RE.test(candidate)) return null;
  const host = candidate.includes('.') ? candidate : `${candidate}.com`;
  return { host, url: `https://${host}/` };
}

/**
 * An explicitly typed URL after the verb — "navigate to https:// + host + /",
 * or scheme-less "host.tld/path" — used VERBATIM (path, query and all)
 * instead of being collapsed to a bare-hostname guess. HOSTNAME_RE alone
 * rejects these (the scheme's "://" and any "/path" are not hostname
 * characters), which used to drop the whole message through to plain chat —
 * and paired-mode chat has no navigate tool, so the request silently became
 * a text answer. Scheme-less input needs BOTH a dotted hostname and a "/"
 * path ("settings/profile" has no dot and stays rejected); with a scheme,
 * only http/https are accepted.
 */
function extractExplicitUrl(message: string): { host: string; url: string } | null {
  const m = GENERIC_TAIL_RE.exec(message.trim());
  if (!m) return null;
  let rest = m[1].trim().replace(/[.?!]+$/, '').trim();
  rest = stripFillers(rest);
  if (!rest || /\s/.test(rest)) return null;
  const hasScheme = /^https?:\/\//i.test(rest);
  if (!hasScheme && !(rest.includes('/') && rest.slice(0, rest.indexOf('/')).includes('.'))) return null;
  let u: URL;
  try {
    u = new URL(hasScheme ? rest : `https://${rest}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!HOSTNAME_RE.test(u.hostname) || !u.hostname.includes('.')) return null;
  return { host: u.hostname, url: u.toString() };
}

// Independent of ACTION_VERBS/GENERIC_TAIL_RE above — "go back"/"head back"
// don't contain "go to", and the destination is history, not a site. Same
// "entire remainder must collapse to nothing" discipline as
// extractGenericSite's single-token rule keeps "go back to work on the
// report" (leftover "to work on the report") from false-positiving.
const HISTORY_TAIL_RE = /\b(?:go|navigate|head|take\s+me)\s+(back|forward)\b\s*(.*)$/i;
const PAGE_PHRASE_RE = /^(?:to\s+)?(?:the\s+)?(?:previous|last|next)\s+page$/i;

function extractHistoryDirection(message: string): 'back' | 'forward' | null {
  const m = HISTORY_TAIL_RE.exec(message.trim());
  if (!m) return null;
  let rest = m[2].trim().replace(/[.?!]+$/, '').trim();
  rest = rest.replace(PAGE_PHRASE_RE, '').trim();
  rest = stripFillers(rest);
  if (rest) return null;
  return m[1].toLowerCase() as 'back' | 'forward';
}

/**
 * Requires BOTH an action verb AND (an adapter alias OR a generic single-
 * token site) — either alone is too easy to false-positive on (a message
 * that merely mentions a site in passing, or a verb with no site named).
 */
export function detectActionIntent(
  message: string,
  adapters: readonly AgentAdapter[] = AGENT_ADAPTERS,
): ActionIntent | null {
  const direction = extractHistoryDirection(message);
  if (direction) return { kind: 'history', direction };

  const lower = message.toLowerCase();
  if (!ACTION_VERBS.some((v) => lower.includes(v))) return null;

  // An explicitly typed URL is the strongest possible statement of intent, so
  // it outranks the adapter-alias tier: "go to https://www.linkedin.com/jobs/"
  // must open THAT page, not the alias's hardcoded site root.
  const explicit = extractExplicitUrl(message);
  if (explicit) return { kind: 'host', host: explicit.host, label: explicit.host, url: explicit.url };

  for (const adapter of adapters) {
    const alias = adapterAlias(adapter);
    if (!alias || !lower.includes(alias)) continue;
    const host = adapter.hosts[0];
    if (!host) continue;
    return { kind: 'adapter', adapterId: adapter.id, label: adapter.label, url: `https://${host}/` };
  }

  const generic = extractGenericSite(message);
  if (generic) return { kind: 'host', host: generic.host, label: generic.host, url: generic.url };

  return null;
}
