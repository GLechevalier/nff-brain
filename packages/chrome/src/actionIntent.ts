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
  | { kind: 'host'; host: string; label: string; url: string };

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
  rest = rest.replace(/\s+(please|now|for me)$/i, '').replace(/[.?!]+$/, '').trim();
  if (!rest || /\s/.test(rest)) return null;
  const candidate = rest.toLowerCase();
  if (!HOSTNAME_RE.test(candidate)) return null;
  const host = candidate.includes('.') ? candidate : `${candidate}.com`;
  return { host, url: `https://${host}/` };
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
  const lower = message.toLowerCase();
  if (!ACTION_VERBS.some((v) => lower.includes(v))) return null;

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
