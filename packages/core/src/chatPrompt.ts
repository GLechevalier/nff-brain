// The Brain tab's Manual-mode chat — the pure prompt half. Deliberately asks
// for PLAIN PROSE, not JSON: a chat answer is not a structured-extraction
// task, and parsing prose out of JSON would only add a brittleness this
// doesn't need. The route trims the raw runClaude() output directly as the
// answer — see packages/cli/src/serve/chatRoutes.ts.
//
// Sources shown to the user are the nodes RETRIEVED for this prompt (computed
// by the caller via the same fuseRanked() /v1/search already uses), never a
// model self-reported citation — that would risk a hallucinated reference to
// a node that was never actually fed to the model.

import { NFF_PROMPT_MARKERS } from './promptMarkers.js';

export const CHAT_MESSAGE_MAX = 2000;
export const CHAT_HISTORY_TURNS_MAX = 6;
export const CHAT_HISTORY_TEXT_MAX = 400;
export const CHAT_NODE_EXCERPT_MAX = 400;
export const CHAT_ANSWER_MAX = 4000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatContextNode {
  id: string;
  title: string;
  content: string;
}

export interface ChatPromptParams {
  message: string;
  /** Most recent first or last — order doesn't matter, buildChatPrompt re-sorts oldest-first for a natural read. */
  history: readonly ChatTurn[];
  nodes: readonly ChatContextNode[];
}

function turnLine(t: ChatTurn): string {
  const who = t.role === 'user' ? 'User' : 'You';
  return `${who}: ${t.text.slice(0, CHAT_HISTORY_TEXT_MAX)}`;
}

function nodeLine(n: ChatContextNode, i: number): string {
  return `#${i} "${n.title}": ${n.content.slice(0, CHAT_NODE_EXCERPT_MAX)}`;
}

export function buildChatPrompt(params: ChatPromptParams): string {
  const history = params.history.slice(-CHAT_HISTORY_TURNS_MAX);
  const lines = [
    `${NFF_PROMPT_MARKERS.chat} for a coding agent's knowledge brain, talking directly with the person whose brain this is.`,
    ``,
    `Answer in plain prose — no JSON, no code fence, no preamble like "Based on your notes". If the notes below don't`,
    `actually answer the question, say so honestly rather than padding with generic advice.`,
    ``,
  ];
  if (params.nodes.length > 0) {
    lines.push(`RELEVANT NOTES FROM THE BRAIN:`, ...params.nodes.map(nodeLine), ``);
  } else {
    lines.push(`(no notes in the brain matched this well enough to include)`, ``);
  }
  if (history.length > 0) {
    lines.push(`RECENT CONVERSATION:`, ...history.map(turnLine), ``);
  }
  lines.push(`QUESTION: ${params.message.slice(0, CHAT_MESSAGE_MAX)}`);
  return lines.join('\n');
}

/**
 * The prompt asks for plain prose, but the model doesn't always comply — this
 * strips the markdown it slips in anyway so the panel (plain textContent, no
 * renderer) never shows raw emphasis/code/header/bullet syntax. Order matters: fences first (so
 * code content isn't mangled by the later passes), bullets/headers next
 * (line-anchored, before bold/italic touch mid-line asterisks), then bold
 * before italic (else "**x**" would be left as "*x*" by the italic pass).
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```(?:\w*)?\n?([\s\S]*?)\n?```/g, '$1')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

export function cleanChatAnswer(raw: string): string {
  return stripMarkdown(raw.trim()).trim().slice(0, CHAT_ANSWER_MAX);
}
