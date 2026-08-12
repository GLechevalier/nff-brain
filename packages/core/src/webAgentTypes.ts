// Shared shapes for the web agent (EPIC-chrome.md item 7): a natural-language
// goal becomes a plan, the plan is approved once, then the server drives a
// LinkedIn content script through a narrow, fixed action vocabulary up to a
// rate cap, logging every real action and optionally pushing matches to a
// user-configured MCP tool ("the list").
//
// One active run globally — the browser has no workspace concept, the same
// structural fact the epic already resolved for clips. Concurrent runs are
// out of scope.

import type { McpToolDef } from './mcpClient.js';

/**
 * Actions the orchestration layer can hand the SW, via /v1/agent/next-action.
 * `navigate` is resolved ENTIRELY by the SW itself (chrome.tabs.update/create)
 * and never reaches a content script; `readResultCards`/`clickConnect` are the
 * only two verbs that cross into packages/chrome/src/protocol.ts's SwToContent
 * union — deliberately narrow, never arbitrary DOM eval.
 */
export type WebAgentVerb = 'navigate' | 'readResultCards' | 'clickConnect';

/** One card as read off a LinkedIn results page. cardIndex is DOM position — what clickConnect(cardIndex) targets. */
export interface AgentCardResult {
  cardIndex: number;
  name: string;
  headline: string;
  company?: string;
}

export interface NextAction {
  /** The plan step this action serves — for a queued clickConnect, the evaluateCards step that queued it. */
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
}

/**
 * planning    — goal submitted, runClaude() plan generation in flight
 * awaiting_approval — plan produced, waiting on the user
 * running     — approved, SW is polling for actions
 * stopping    — Stop requested; no new actions granted, in-flight one may finish
 * stopped     — terminal, user-initiated
 * done        — terminal, cap reached or plan exhausted
 * error       — terminal, planning failed
 *
 * No `paused`: Stop is terminal by design (the "autonomous, rate-capped,
 * killable" decision), not a resumable pause.
 */
export type RunPhase = 'planning' | 'awaiting_approval' | 'running' | 'stopping' | 'stopped' | 'done' | 'error';

/** Planning-time verbs — mechanical (searchPeople) or a judgment call (evaluateCards). */
export type PlanVerb = 'searchPeople' | 'evaluateCards';

export interface PlanStep {
  /** "step-<n>", minted by the server from array position — never the model's own id. */
  id: string;
  summary: string;
  verb: PlanVerb;
  args: Record<string, string>;
}

export interface WebAgentPlan {
  goal: string;
  site: 'linkedin';
  /** The semantic filter a human would apply, e.g. "robotics engineer at a Series A startup". */
  criteria: string;
  steps: PlanStep[];
  /** Echoed cap for the approval UI — already clamped server-side. */
  maxActions: number;
  createdAt: string;
}

/**
 * Where a successful clickConnect should be written — chosen by the user at
 * goal time. `toolDef` is snapshotted once (a live `tools/list` call) when
 * the goal is submitted, so a per-connect list-write never needs its own
 * round trip to the MCP server just to re-read the schema, and a mid-run
 * schema change on the far end cannot retarget an already-approved run.
 */
export interface WebAgentListTarget {
  server: string; // McpServerConfig id
  tool: string;
  toolDef: McpToolDef;
}

export interface ActionResult {
  ok: boolean;
  summary: string;
  /** clickConnect: the connected person's fields. */
  fields?: Record<string, string>;
  /** readResultCards: what was read off the page. */
  cards?: AgentCardResult[];
  reportedAt: string;
  listWriteError?: string;
}

export interface ActionRecord {
  stepId: string;
  verb: WebAgentVerb;
  args: Record<string, string>;
  requestedAt: string;
  result?: ActionResult;
}

export interface WebAgentRun {
  id: string; // run_<epochMs>_<6hex>
  phase: RunPhase;
  /** Owning paired extension client — no cross-client control. */
  clientId: string;
  goal: string;
  plan: WebAgentPlan | null;
  listTarget: WebAgentListTarget | null;
  /** Index into plan.steps. */
  cursor: number;
  /**
   * Matches queued by the most recent evaluateCards filter call, drained one
   * clickConnect per next-action poll (so each still gets its own pacing
   * delay and cap decrement) before the cursor advances past that step.
   */
  pendingConnects: AgentCardResult[];
  /** The evaluateCards step id that queued pendingConnects — null when empty. */
  pendingConnectsStepId: string | null;
  /** Toward maxActions — clickConnect only. */
  actionsTaken: number;
  maxActions: number;
  /** Server-authoritative pacing gate. */
  nextAllowedAtMs: number;
  createdAt: string;
  updatedAt: string;
  /** Capped at 200. */
  history: ActionRecord[];
  error?: string;
}

export interface WebAgentState {
  version: 1;
  active: WebAgentRun | null;
  recent: WebAgentRun[];
}

export const WEB_AGENT_HISTORY_MAX = 200;
export const WEB_AGENT_RECENT_MAX = 20;
