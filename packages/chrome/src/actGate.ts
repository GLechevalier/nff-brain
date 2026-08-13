// THE WEB-AGENT ENGINE'S CHOKE POINT — the "is this action allowed on this
// origin right now" decision, deliberately separate from agentGate.ts (the
// LinkedIn recorder-agent's on/off) and gate.ts (the passive recorder's
// capture rule). Three different questions, three different files, so turning
// one on never silently widens another.
//
// Verb CLASS is the unit of consent (see @nff-brain/core/browserVerbs
// verbClass): reads and navigation come free with a started run; the first
// input on an origin needs a grant; anything destructive is confirmed every
// run unless the origin was granted "always".
//
// Pure — zero chrome.*, no node:*, only a type import. vitest imports it
// directly and bundlePurity pins it node-free, same discipline as agentGate.ts.

import type { VerbClass } from '@nff-brain/core/browserVerbs';

/** Persisted per-origin grant (nb.actHostAllow). "once" is never persisted — it lives on the run. */
export type OriginGrant = 'always' | 'never';

export interface ActHostAllowState {
  /** Keyed by origin (scheme://host[:port]). */
  byOrigin: Record<string, OriginGrant>;
}

export type GateDecision = 'allow' | 'deny' | 'prompt';

export interface ActGateInput {
  verbClass: VerbClass;
  /** Persisted grant for the target origin, if any. */
  persisted: OriginGrant | undefined;
  /** True when the user granted this origin "once" earlier in THIS run. */
  sessionGranted: boolean;
}

/**
 * NEVER THROWS. Decide whether the engine may dispatch a verb of this class.
 *
 * - observe / navigate: always allowed — a started run consents to reading the
 *   page and moving between pages. ('never' blocks acting ON a page, not
 *   looking at it.)
 * - interact: allowed if the origin is granted (persisted "always" or a
 *   session "once"); otherwise prompt. Persisted "never" denies.
 * - destructive: allowed ONLY with persisted "always"; a session "once" still
 *   prompts, because a hard-to-undo action deserves a fresh confirmation each
 *   run. "never" denies.
 */
export function decideAct(i: ActGateInput): GateDecision {
  if (i.verbClass === 'observe' || i.verbClass === 'navigate') return 'allow';
  if (i.persisted === 'never') return 'deny';
  if (i.verbClass === 'destructive') return i.persisted === 'always' ? 'allow' : 'prompt';
  // interact
  if (i.persisted === 'always' || i.sessionGranted) return 'allow';
  return 'prompt';
}

/** scheme://host[:port] for a url, or null if unparseable. The gate's key. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** URLs the engine refuses to attach the debugger to, regardless of grants. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true; // chrome:, chrome-extension:, file:, about:, data:
  const host = u.hostname.toLowerCase();
  // Chrome refuses debugger attach on the Web Store; guard it explicitly so the
  // failure is a clear message, not an opaque CDP reject.
  if (host === 'chromewebstore.google.com' || host === 'chrome.google.com') return true;
  return false;
}
