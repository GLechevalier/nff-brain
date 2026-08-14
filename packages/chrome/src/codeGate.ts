// THE CODING AGENT'S CONSENT CHOKE POINT — "may this code tool run right now",
// deliberately separate from actGate.ts (CDP origin consent), agentGate.ts
// (LinkedIn automation), and gate.ts (capture). Code tools have no tab and no
// origin, so origin-keyed decideAct() cannot model them; this gate's unit of
// consent is the TOOL CLASS, scoped to the current run.
//
// - code-read: free once a project folder is attached — attaching the folder
//   IS the consent to read it, the same logic by which a started run consents
//   to reading the page. Still path-jailed (codePath.ts) and transcript-logged.
// - code-write / code-exec: prompt per action unless the user answered
//   "Always" for that class earlier THIS run (ActRunState.codeGrants) or
//   flipped the run's auto-approve toggle (which sets both flags). Nothing is
//   ever persisted beyond the run: a coding agent's write consent should not
//   outlive the session.
//
// Pure — zero chrome.*, no node:*, vitest imports it directly, same
// discipline as actGate.ts.

export type CodeToolClass = 'code-read' | 'code-write' | 'code-exec';

/** No 'deny' tier: there is no persisted "never" for code tools — the user
 *  answers Never per action, which the executor reports as a declined result
 *  (the run continues) rather than a gate state. */
export type CodeGateDecision = 'allow' | 'prompt';

export interface CodeGateInput {
  cls: CodeToolClass;
  /** True when THIS run already carries an "Always" for the class — from a
   *  grant answered 'always' or the panel's auto-approve toggle. */
  sessionGranted: boolean;
}

/** NEVER THROWS. Decide whether a code tool may run without asking. */
export function decideCode(i: CodeGateInput): CodeGateDecision {
  if (i.cls === 'code-read') return 'allow';
  return i.sessionGranted ? 'allow' : 'prompt';
}
