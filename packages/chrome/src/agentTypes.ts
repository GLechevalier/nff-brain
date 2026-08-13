// Web agent (item 7) adapter contracts — pure types, no chrome.*. Mirrors
// recorderTypes.ts's split on purpose: this is a SEPARATE opt-in from the
// passive recorder (a user can have the LinkedIn recorder on, the agent off,
// or both), even though v1 happens to target the same site.

export interface AgentAdapter {
  /** Stable id — storage key member and message discriminator. */
  id: string;
  /** Shown wherever the opt-in toggle lives (popup, agent page). */
  label: string;
  /** Hosts this adapter is allowed to act on — agentGate.ts's own boundary. */
  hosts: string[];
  /** Origin patterns for chrome.permissions.request at enable time. */
  originPatterns: string[];
  /** Match patterns for chrome.scripting.registerContentScripts. */
  matches: string[];
  /** Built content-script file in dist/ (see build.mjs CONTENT list). */
  scriptFile: string;
}

export interface AgentAdapterState {
  byId: Record<string, { enabled: boolean; changedAt: string }>;
}

/**
 * Manual-mode chat's "never ask again" standing consent — deliberately its
 * own store, not a repurposing of AgentAdapterState: "the autonomous agent is
 * enabled" and "silently open a tab for this adapter without asking" are two
 * different questions, same reasoning that kept this file split from
 * recorderTypes.ts in the first place.
 */
export interface AgentActionAllowState {
  byId: Record<string, { allowed: boolean; changedAt: string }>;
}

/**
 * Host-keyed twin of AgentActionAllowState, for navigate targets with no
 * registered adapter (actionIntent.ts's generic "kind: 'host'" match — any
 * site, not just the ones with real DOM-automation behind them).
 */
export interface NavigateHostAllowState {
  byHost: Record<string, { allowed: boolean; changedAt: string }>;
}

/**
 * The tab the SW is currently driving for the active run. Storage, never a
 * module variable — the poll loop resumes across worker deaths via
 * chrome.alarms, and it needs to find the SAME tab it was using, not open a
 * fresh one every time it wakes up.
 */
export interface AgentTabRef {
  tabId: number;
  adapterId: string;
}
