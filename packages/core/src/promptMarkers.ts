// Opening phrases of every prompt nff-brain sends through `claude -p`.
//
// These exist in ONE place because two unrelated things depend on them being
// identical, and neither would fail loudly if they drifted:
//
//   1. The prompt builders themselves (distill, init, merge, graphify, import).
//   2. The history importer's one-shot detector. Each `claude -p` call lands in
//      ~/.claude/projects as its own session transcript, so without this the
//      importer happily mines nff-brain's own distiller prompts back into the
//      brain — a feedback loop that reads as "the import found 40 memories
//      about being a memory distiller".
//
// Change a prompt's opening line and you MUST change it here.

export const NFF_PROMPT_MARKERS = {
  distill: 'You are the memory distiller',
  architect: 'You are the memory architect',
  curator: 'You are the memory curator',
  explainer: 'You are the graph explainer',
  archaeologist: 'You are the memory archaeologist',
  clipper: 'You are the memory clipper',
  agentPlanner: 'You are the web agent planner',
  agentFilter: "You are the web agent's judgment call",
  agentListWrite: "You are the web agent's list-write field mapper",
} as const;

export const NFF_PROMPT_PREFIXES: readonly string[] = Object.values(NFF_PROMPT_MARKERS);

/** True when this text is the opening of a prompt nff-brain itself wrote. */
export function isNffPrompt(text: string): boolean {
  const t = text.trimStart();
  return NFF_PROMPT_PREFIXES.some((p) => t.startsWith(p));
}
