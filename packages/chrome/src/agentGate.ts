// THE AGENT'S OWN CHOKE POINT — deliberately separate from shouldCapture()
// in gate.ts. A different question: "is DOM automation allowed on this URL
// right now", not "should this event be captured". Keeping it a distinct
// function (rather than reusing shouldCapture) means enabling/disabling the
// agent never touches the passive recorder's pause+allowlist semantics, and
// vice versa — a user can run one without the other.
//
// Zero imports beyond types, no chrome.*, no node:* — vitest imports it
// directly and bundlePurity.test.ts asserts it stays that way, same
// discipline as gate.ts.

export interface AgentGateState {
  agentEnabled: boolean;
  /** The adapter's own fixed host list — never a user-editable allowlist. */
  hosts: readonly string[];
}

/** NEVER THROWS. An unparseable URL is false, not an exception. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** THE agent choke point. Called before the SW dispatches any DOM command to a content script. */
export function shouldRunAgentAction(url: string | undefined, state: AgentGateState): boolean {
  if (!state.agentEnabled) return false;
  if (!url) return false;
  const host = hostOf(url);
  return host !== null && state.hosts.includes(host);
}
