// Manual-mode chat over the direct provider API (BYOK) — the standalone
// sibling of the paired /v1/chat route, resurrected from the deleted
// standalone.ts's localChat. sw.ts routes 'chatAsk' here when mode.ts
// resolves 'byok'; the paired case stays byte-identical.
//
// Retrieval reads the LOCAL brain (nb.brain — fed by the BYOK clip drain and
// the import-from-server button), so answers cite sources with no server.

import { buildChatPrompt, cleanChatAnswer, expandSkillHits } from '@nff-brain/core/chatPrompt';
import { ProviderError } from '@nff-brain/core/provider';
import { fuseRanked } from '@nff-brain/core/rank';
import { readLocalBrain } from './brainStore.js';
import { executeNavigate, NAVIGATE_TOOL_SPEC } from './navigateTool.js';
import { runChatWithTools } from './providerClient.js';
import type { SwToPopup } from './protocol.js';

const CHAT_RETRIEVAL_LIMIT = 8;

// Only this (BYOK) chat path actually has the navigate tool wired in — the
// paired Manual-mode chat (chatRoutes.ts) has no tool-calling at all, so this
// steering line stays out of the shared buildChatPrompt() and is appended
// here instead, where it's true.
const NAVIGATE_STEERING =
  'You may use the navigate tool to open a page when the user clearly asks you to — not for a casual mention of a link, and never more than one page per request unless asked.';

/** Rank the local brain against the message. A skill hit collapses to its
 *  whole tree in ONE slot — see expandSkillHits: without this a 10-node skill
 *  would take every retrieval slot and could surface a mid-tree step with no
 *  root to hang it off. An empty local brain simply retrieves nothing. */
async function retrieveChatNodes(message: string) {
  const brain = await readLocalBrain();
  const ranked = fuseRanked(message, brain.nodes, null, { limit: CHAT_RETRIEVAL_LIMIT });
  const { skills, plain } = expandSkillHits(brain.nodes, ranked.map((r) => r.node));
  return [...skills, ...plain].map((n) => ({
    id: n.id,
    title: n.title,
    content: n.content ?? '',
    ...(n.skill ? { skill: n.skill } : {}),
  }));
}

export async function byokChatAsk(
  message: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  tabId: number,
): Promise<SwToPopup> {
  const nodes = await retrieveChatNodes(message);
  try {
    const prompt = `${buildChatPrompt({ message, history, nodes })}\n\n${NAVIGATE_STEERING}`;
    const result = await runChatWithTools(prompt, [
      { spec: NAVIGATE_TOOL_SPEC, run: (input) => executeNavigate(input, tabId) },
    ]);
    if (!result) {
      return { type: 'error', message: 'add an API key in Settings to chat (or pair with a local server)' };
    }
    let answer = cleanChatAnswer(result.answer);
    // A bare tool result is easy for the model to omit or phrase awkwardly —
    // inject a confirmation note for a successful navigate. A FAILED navigate
    // is left to the model's own prose: it already saw the failure reason as
    // a tool_result and can narrate it, so no separate note is needed there.
    const opened = result.toolEvents.filter((e) => e.name === 'navigate' && e.ok);
    if (opened.length > 0) {
      const note = opened.map((e) => e.summary).join(', ');
      answer = answer ? `${answer}\n\n(${note})` : note;
    }
    return {
      type: 'chatAnswer',
      answer,
      sources: nodes.map((n) => ({ id: n.id, title: n.title })),
    };
  } catch (err) {
    // ProviderError messages are short and user-showable by construction.
    return { type: 'error', message: err instanceof ProviderError ? err.message : 'the model did not answer in time' };
  }
}
