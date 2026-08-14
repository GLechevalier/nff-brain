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
import type {
  ChatContentBlock,
  ChatMessage,
  ModelSlot,
  ProviderChatResult,
  ProviderChatUsage,
  ProviderRequest,
  ProviderStreamParser,
  ToolSpec,
} from '@nff-brain/core/provider';
import type { ProviderTestResult } from './schema.js';
import { getProviderSettings, setProviderSettings } from './storage.js';

export type OneShot = (prompt: string) => Promise<string>;

/** background mirrors runClaude's 60s; chat mirrors the serve chat route's 45s. */
export const PROVIDER_TIMEOUT_MS: Record<ModelSlot, number> = { background: 60_000, chat: 45_000 };

const MAX_TOKENS: Record<ModelSlot, number> = { background: 4096, chat: 4096 };

async function send(req: ProviderRequest, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      // AbortSignal.any needs Chrome 116+, exactly the manifest's minimum.
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    // A caller-initiated abort (Stop) is its own kind — NOT retryable, NOT a
    // provider failure — checked before the timeout shape because an aborted
    // fetch also surfaces as a DOMException.
    if (signal?.aborted) throw new ProviderError('aborted', 'stopped');
    // Timeout and network failures are the same thing to a caller: retryable.
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ProviderError('overloaded', timedOut ? 'the provider did not answer in time' : 'could not reach the provider');
  }
  return { status: res.status, body: await res.text() };
}

/** No overall deadline on a stream (long answers are legal) — only a stall
 *  detector: this long with zero bytes means the connection is dead. */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * The streaming sibling of send(): POST the request, pipe the SSE body through
 * the adapter's parser, surface text deltas as they land, and return the fully
 * assembled result. Non-2xx statuses read the (plain JSON) error body and let
 * `parseError` throw the same mapped ProviderError the blocking path would.
 */
async function sendStream(
  req: ProviderRequest,
  parser: ProviderStreamParser,
  onTextDelta: (t: string) => void,
  parseError: (status: number, bodyText: string) => ProviderChatResult,
  signal?: AbortSignal,
): Promise<ProviderChatResult> {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
  } catch {
    if (signal?.aborted) throw new ProviderError('aborted', 'stopped');
    throw new ProviderError('overloaded', 'could not reach the provider');
  }
  if (res.status < 200 || res.status >= 300) return parseError(res.status, await res.text());
  if (!res.body) throw new ProviderError('malformed', 'provider returned no stream body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ProviderError('overloaded', 'the provider stream stalled')), STREAM_IDLE_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('aborted', 'stopped');
        throw err instanceof ProviderError ? err : new ProviderError('overloaded', 'the provider stream failed');
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      for (const t of parser.feed(decoder.decode(step.value, { stream: true }))) onTextDelta(t);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  for (const t of parser.feed(decoder.decode())) onTextDelta(t);
  return parser.finish();
}

/** Flag a dead key where the UI can see it, without changing the thrown error. */
async function recordAuthFailure(message: string): Promise<void> {
  const s = await getProviderSettings();
  if (!s) return;
  await setProviderSettings({ ...s, lastTest: { ok: false, at: new Date().toISOString(), message } });
}

/**
 * Null means "no provider configured" — the caller decides what that implies
 * (the drain waits; trace distillation reports "add an API key"). The
 * 'background' slot's live call sites: standaloneDrain.ts (clip → nodes) and
 * standaloneTraceDistill.ts (recording → workflow).
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

/** Per-run knobs threaded into every request of a chat loop. */
interface ChatCallTuning {
  /** Top-level system prompt; setting it also turns prompt caching on. */
  system?: string;
  thinking?: 'disabled' | 'adaptive';
  /** Override the slot's MAX_TOKENS ceiling (the act loop wants a tighter one). */
  maxTokens?: number;
  /** Caller-initiated abort (Stop) — surfaces as ProviderError 'aborted'. */
  signal?: AbortSignal;
  /**
   * Turn streaming on: assistant text arrives here as it generates, and the
   * whole request rides SSE (mid-stream abort included). Silently falls back
   * to the blocking path when the adapter can't stream.
   */
  onTextDelta?: (t: string) => void;
}

/**
 * Same null-if-unconfigured contract as makeProviderOneShot, plus: null also
 * when the configured adapter doesn't implement the tool-calling methods yet
 * (only anthropicAdapter does today) — callers degrade the same way either way.
 */
async function makeProviderChatOneShot(
  slot: ModelSlot,
  tuning: ChatCallTuning = {},
): Promise<((messages: ChatMessage[], tools: ToolSpec[]) => Promise<ProviderChatResult>) | null> {
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter || !adapter.buildChatRequest || !adapter.parseChatResponse) return null;
  const model = s.models[slot] || adapter.defaultModels[slot];
  const buildChatRequest = adapter.buildChatRequest;
  const parseChatResponse = adapter.parseChatResponse;

  const streaming = tuning.onTextDelta !== undefined && adapter.createStreamParser !== undefined;
  const createStreamParser = adapter.createStreamParser;

  return async (messages, tools) => {
    const req = buildChatRequest(
      {
        messages,
        model,
        maxTokens: tuning.maxTokens ?? MAX_TOKENS[slot],
        tools,
        system: tuning.system,
        // Caching rides with a system prompt: that's the stable prefix worth
        // a breakpoint. Plain chat (no system) keeps the pre-cache request shape.
        cache: tuning.system !== undefined,
        thinking: tuning.thinking,
        stream: streaming,
      },
      s.apiKey,
    );
    try {
      if (streaming) {
        return await sendStream(req, createStreamParser!(), tuning.onTextDelta!, parseChatResponse, tuning.signal);
      }
      const { status, body } = await send(req, PROVIDER_TIMEOUT_MS[slot], tuning.signal);
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

/** Mirror of the paired loop's per-result clip (actRun.ts history) — applied
 *  at append time so an oversized tool result never enters history at all,
 *  which keeps every already-sent byte stable for the prompt cache. */
export const TOOL_RESULT_MAX_CHARS = 6000;

export const SNAPSHOT_STUB_NOTE = '\n…[stale snapshot truncated — its refs have expired; use the latest read_page below]';
const SNAPSHOT_STUB_KEEP = 300;

/** Backstop only — with the act loop's 24-turn cap this should never fire. */
const HISTORY_MAX_BLOCKS = 60;

/**
 * Truncate SUPERSEDED snapshot tool_results (ids in `snapshotToolUseIds`) to a
 * short stub, keeping only the NEWEST one full — old page snapshots are the
 * bulk of the history and their element refs are dead the moment a newer
 * snapshot exists. Mutates blocks in place; idempotent (already-stubbed blocks
 * are skipped, byte-stable forever after).
 *
 * CACHE NOTE: called right after a new snapshot lands, this rewrites at most
 * the previous turn's result — costing one turn of cache re-write — and never
 * touches anything older. Do NOT be tempted to re-clip the whole history each
 * turn the way the paired loop does: churning early bytes would zero the
 * prompt-cache prefix on every single request.
 */
export function compactSupersededSnapshots(messages: ChatMessage[], snapshotToolUseIds: ReadonlySet<string>): void {
  const hits: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && snapshotToolUseIds.has(b.tool_use_id)) hits.push(b);
    }
  }
  for (let i = 0; i < hits.length - 1; i++) {
    const b = hits[i]!;
    // The length gate is also the idempotence gate: a stubbed block is exactly
    // SNAPSHOT_STUB_KEEP + note long, so it can never be re-truncated.
    if (b.content.length <= SNAPSHOT_STUB_KEEP + SNAPSHOT_STUB_NOTE.length) continue;
    b.content = b.content.slice(0, SNAPSHOT_STUB_KEEP) + SNAPSHOT_STUB_NOTE;
  }
}

function countBlocks(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === 'string' ? 1 : m.content.length), 0);
}

/**
 * Overflow backstop: drop the oldest assistant/user exchange after the goal
 * message. Removing the PAIR keeps tool_use/tool_result adjacency intact.
 * This does churn early bytes (cache re-write) — acceptable for a path that
 * only exists so a pathological run can't grow unbounded.
 */
function trimHistoryOverflow(messages: ChatMessage[]): void {
  while (countBlocks(messages) > HISTORY_MAX_BLOCKS && messages.length > 3) {
    messages.splice(1, 2);
  }
}

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
  /**
   * Called with each turn's assistant text BEFORE its tool calls run (skipped
   * when a turn has no text — most turns that call a tool say nothing).
   * Otherwise every intermediate turn's reasoning is silently discarded — only
   * the FINAL turn's text survives as `answer`. The web-agent run uses this to
   * log the agent's per-step reasoning, not just its closing summary.
   */
  onAssistantText?: (text: string) => void;
  /** See ChatCallTuning — setting `system` also turns prompt caching on. */
  system?: string;
  thinking?: 'disabled' | 'adaptive';
  maxTokens?: number;
  /** Caller-initiated abort (Stop): the in-flight request throws ProviderError 'aborted'. */
  signal?: AbortSignal;
  /**
   * Tool names whose superseded results get compacted to a stub each turn
   * (the act loop passes ['read_page'] — old snapshots are dead weight).
   */
  compactToolNames?: string[];
  /** Per-turn token accounting when the provider reports it — the act loop
   *  logs it so a dead prompt cache (cache_read 0) is visible, not silent. */
  onUsage?: (usage: ProviderChatUsage) => void;
  /**
   * Streaming: each assistant text fragment as it generates (before the turn
   * settles). onAssistantText still fires once with the turn's complete text
   * — a delta consumer that already rendered the stream should treat that
   * final call as its finalize signal, not append it again.
   */
  onAssistantTextDelta?: (t: string) => void;
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
  const chatOneShot = await makeProviderChatOneShot('chat', {
    system: opts.system,
    thinking: opts.thinking,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    onTextDelta: opts.onAssistantTextDelta,
  });
  if (!chatOneShot) return null;

  const maxTurns = opts.maxTurns ?? MAX_CHAT_TOOL_TURNS;
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const compactNames = new Set(opts.compactToolNames ?? []);
  const snapshotToolUseIds = new Set<string>();
  const messages: ChatMessage[] = opts.priorMessages
    ? [...opts.priorMessages]
    : [{ role: 'user', content: initialPrompt }];
  const toolEvents: ChatWithToolsResult['toolEvents'] = [];
  let lastText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chatOneShot(messages, specs);
    if (result.usage) opts.onUsage?.(result.usage);
    lastText = result.text;
    if (result.toolCalls.length === 0) return { answer: result.text, toolEvents };
    if (result.text) opts.onAssistantText?.(result.text);

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
      if (compactNames.has(call.name)) snapshotToolUseIds.add(call.id);
      // Clip at APPEND time (never later) so an oversized result can't bloat
      // every subsequent request — and so already-sent bytes stay cache-stable.
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: resultText.slice(0, TOOL_RESULT_MAX_CHARS), is_error: !ok });
    }
    messages.push({ role: 'user', content: resultBlocks });
    if (snapshotToolUseIds.size > 1) compactSupersededSnapshots(messages, snapshotToolUseIds);
    trimHistoryOverflow(messages);

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
