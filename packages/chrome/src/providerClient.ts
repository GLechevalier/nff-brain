// The fetch half of the BYOK provider layer. Adapters (@nff-brain/core/provider)
// are pure build/parse; this module is the ONLY place a provider request is
// actually sent, and the only chrome module that imports the provider subpath.
//
// Error contract for callers:
//   - 'background' slot (standalone drain): FAIL-OPEN — catch, leave the batch
//     queued, back off to the next alarm tick. Exception: a ProviderError with
//     kind 'auth' is ALSO persisted into settings.lastTest here, because a dead
//     key silently retried forever is the 401-vs-disconnect lesson from
//     ConnectionPhase 'rejected'. The drain still fails open; the options page
//     and popup render the flag.
//   - 'chat' slot: surface ProviderError.message to the panel — it is short and
//     user-showable by construction (never the key, never a stack).
//
// NO module-level state (pinned by bundlePurity) — settings are read from
// storage at call time, so a key change applies to the very next call.

import { PROVIDERS, ProviderError } from '@nff-brain/core/provider';
import type { ChatContentBlock, ChatMessage, ModelSlot, ProviderChatResult, ProviderRequest, ToolSpec } from '@nff-brain/core/provider';
import type { ProviderTestResult } from './schema.js';
import { getProviderSettings, setProviderSettings } from './storage.js';

export type OneShot = (prompt: string) => Promise<string>;

/** background mirrors runClaude's 60s; chat mirrors the serve chat route's 45s. */
export const PROVIDER_TIMEOUT_MS: Record<ModelSlot, number> = { background: 60_000, chat: 45_000 };

const MAX_TOKENS: Record<ModelSlot, number> = { background: 4096, chat: 4096 };

async function send(req: ProviderRequest, timeoutMs: number): Promise<{ status: number; body: string }> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Timeout and network failures are the same thing to a caller: retryable.
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ProviderError('overloaded', timedOut ? 'the provider did not answer in time' : 'could not reach the provider');
  }
  return { status: res.status, body: await res.text() };
}

/** Flag a dead key where the UI can see it, without changing the thrown error. */
async function recordAuthFailure(message: string): Promise<void> {
  const s = await getProviderSettings();
  if (!s) return;
  await setProviderSettings({ ...s, lastTest: { ok: false, at: new Date().toISOString(), message } });
}

/**
 * Null means "no provider configured" — the caller decides what that implies
 * (the drain waits; chat replies with a pointer at the options page).
 */
export async function makeProviderOneShot(slot: ModelSlot): Promise<OneShot | null> {
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter) return null;
  const model = s.models[slot] || adapter.defaultModels[slot];

  return async (prompt) => {
    const req = adapter.buildRequest(
      { prompt, model, maxTokens: MAX_TOKENS[slot], jsonHint: slot === 'background' },
      s.apiKey,
    );
    const { status, body } = await send(req, PROVIDER_TIMEOUT_MS[slot]);
    try {
      return adapter.parseResponse(status, body);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') await recordAuthFailure(err.message);
      throw err;
    }
  };
}

/**
 * Same null-if-unconfigured contract as makeProviderOneShot, plus: null also
 * when the configured adapter doesn't implement the tool-calling methods yet
 * (only anthropicAdapter does today) — callers degrade the same way either way.
 */
async function makeProviderChatOneShot(
  slot: ModelSlot,
): Promise<((messages: ChatMessage[], tools: ToolSpec[]) => Promise<ProviderChatResult>) | null> {
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter || !adapter.buildChatRequest || !adapter.parseChatResponse) return null;
  const model = s.models[slot] || adapter.defaultModels[slot];
  const buildChatRequest = adapter.buildChatRequest;
  const parseChatResponse = adapter.parseChatResponse;

  return async (messages, tools) => {
    const req = buildChatRequest({ messages, model, maxTokens: MAX_TOKENS[slot], tools }, s.apiKey);
    const { status, body } = await send(req, PROVIDER_TIMEOUT_MS[slot]);
    try {
      return parseChatResponse(status, body);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') await recordAuthFailure(err.message);
      throw err;
    }
  };
}

export interface ToolExecutor {
  spec: ToolSpec;
  /** NEVER THROWS — a failed call becomes a tool_result the model can narrate, not a crashed chat turn. */
  run(input: unknown): Promise<{ ok: boolean; resultText: string }>;
}

export interface ChatWithToolsResult {
  answer: string;
  toolEvents: Array<{ name: string; ok: boolean; summary: string }>;
}

/** Small hard cap on provider round trips per chat turn — same safety-valve spirit as agentRunner's MAX_POLL_CHAIN. */
export const MAX_CHAT_TOOL_TURNS = 3;

export interface RunChatOpts {
  /** Round-trip cap. Defaults to MAX_CHAT_TOOL_TURNS so the chat path is unchanged. */
  maxTurns?: number;
  /** Prior conversation to resume from instead of a single user prompt (the act run's persisted messages). */
  priorMessages?: ChatMessage[];
  /**
   * Called after each assistant turn's tools all ran, with the running message
   * list and this turn's tool events. Return false to stop the loop early (a
   * Stop request, a budget hit). The web-agent run uses this to persist progress
   * and honor cancellation between turns.
   */
  onTurn?: (state: { messages: ChatMessage[]; toolEvents: ChatWithToolsResult['toolEvents']; turn: number }) => Promise<boolean> | boolean;
}

/**
 * Sends the prompt to the 'chat' slot with the given tools; if the model calls
 * one, executes it locally and feeds the result back for up to `maxTurns` round
 * trips. Null means "no provider configured" (same contract as
 * makeProviderOneShot) — standalone.ts's existing "add an API key" branch needs
 * no new shape to handle it.
 *
 * The default (no opts) is byte-identical to the original two-arg chat call:
 * one user prompt, MAX_CHAT_TOOL_TURNS, no onTurn hook.
 */
export async function runChatWithTools(
  initialPrompt: string,
  tools: ToolExecutor[],
  opts: RunChatOpts = {},
): Promise<ChatWithToolsResult | null> {
  const chatOneShot = await makeProviderChatOneShot('chat');
  if (!chatOneShot) return null;

  const maxTurns = opts.maxTurns ?? MAX_CHAT_TOOL_TURNS;
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const messages: ChatMessage[] = opts.priorMessages
    ? [...opts.priorMessages]
    : [{ role: 'user', content: initialPrompt }];
  const toolEvents: ChatWithToolsResult['toolEvents'] = [];
  let lastText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chatOneShot(messages, specs);
    lastText = result.text;
    if (result.toolCalls.length === 0) return { answer: result.text, toolEvents };

    const assistantContent: ChatContentBlock[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const call of result.toolCalls) assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    messages.push({ role: 'assistant', content: assistantContent });

    const resultBlocks: ChatContentBlock[] = [];
    const turnEvents: ChatWithToolsResult['toolEvents'] = [];
    for (const call of result.toolCalls) {
      const executor = byName.get(call.name);
      let ok = false;
      let resultText = 'unknown tool';
      if (executor) {
        try {
          const res = await executor.run(call.input);
          ok = res.ok;
          resultText = res.resultText;
        } catch (err) {
          resultText = err instanceof Error ? err.message : 'tool execution failed';
        }
      }
      const ev = { name: call.name, ok, summary: resultText };
      toolEvents.push(ev);
      turnEvents.push(ev);
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: resultText, is_error: !ok });
    }
    messages.push({ role: 'user', content: resultBlocks });

    if (opts.onTurn) {
      const keepGoing = await opts.onTurn({ messages, toolEvents: turnEvents, turn });
      if (!keepGoing) return { answer: lastText, toolEvents };
    }
  }

  // Cap hit while a tool_use was still pending — return the last text seen
  // (often '') rather than looping forever, same discipline as pollAgent's MAX_POLL_CHAIN.
  return { answer: lastText, toolEvents };
}

/** The options page's "Test connection": cheapest authenticated round trip. */
export async function testProviderKey(): Promise<ProviderTestResult> {
  const at = new Date().toISOString();
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter) return { ok: false, at, message: 'no API key saved yet' };

  let result: ProviderTestResult;
  try {
    const { status, body } = await send(adapter.buildKeyTestRequest(s.apiKey), 15_000);
    adapter.parseResponse(status, body);
    result = { ok: true, at, message: 'key accepted' };
  } catch (err) {
    if (err instanceof ProviderError) {
      // rate_limit/overloaded mean auth SUCCEEDED — key fine, service busy.
      // malformed/refusal only occur on a 2xx (a 1-token reply can parse as
      // "empty"), so those prove the key works too. Only auth/bad_request are
      // real failures.
      if (err.retryable) result = { ok: true, at, message: 'key accepted (provider busy, try again later)' };
      else if (err.kind === 'malformed' || err.kind === 'refusal') result = { ok: true, at, message: 'key accepted' };
      else result = { ok: false, at, message: err.kind === 'auth' ? 'invalid API key' : err.message };
    } else {
      result = { ok: false, at, message: 'could not reach the provider' };
    }
  }
  await setProviderSettings({ ...s, lastTest: result });
  return result;
}
