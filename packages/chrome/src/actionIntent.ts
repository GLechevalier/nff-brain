// Manual-mode chat's action-intent detector — a cheap local heuristic, not an
// LLM call, so it costs nothing extra on every ordinary chat message. Zero
// chrome.*/node:* imports, same testability discipline as gate.ts.
//
// Deliberately narrow: only simple "go open this site" intents are detected
// here. A richer goal ("connect with 5 people in DevRel") still belongs to
// the existing Plan/Auto mode pipeline (buildPlanPrompt/parsePlanResponse),
// which this file does not touch.

import { AGENT_ADAPTERS } from './agentRegistry.js';
import type { AgentAdapter } from './agentTypes.js';

export interface ActionIntent {
  adapterId: string;
  label: string;
  url: string;
}

const ACTION_VERBS = ['navigate', 'go to', 'open', 'visit', 'take me to'];

/** The first host's leading label, e.g. "linkedin" from "www.linkedin.com". */
function adapterAlias(adapter: AgentAdapter): string | null {
  const host = adapter.hosts[0];
  if (!host) return null;
  const label = host.replace(/^www\./, '').split('.')[0];
  return label || null;
}

/**
 * Requires BOTH an adapter alias AND an action verb in the message — either
 * alone is too easy to false-positive on (a message that merely mentions
 * "linkedin" in passing, or "open" with no site named at all).
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
    return { adapterId: adapter.id, label: adapter.label, url: `https://${host}/` };
  }
  return null;
}
