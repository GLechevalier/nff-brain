// BYOK provider adapters for the Chrome extension's standalone mode.
//
// Adapters are PURE request-builders and response-parsers — `fetch` lives in
// the caller (packages/chrome/src/providerClient.ts). That keeps this module
// browser-safe, zero-dependency (the mcpClient.ts rule: no SDKs, hand-rolled
// JSON over HTTP), and testable with no network. This module imports NOTHING.
//
// v1 ships the Anthropic adapter only, but the interface is provider-shaped
// (PROVIDER_CHOICES lists openai/gemini as unavailable) so follow-up adapters
// are drop-in: implement ProviderAdapter, register in PROVIDERS, add the host
// to the manifest CSP + the chrome bundlePurity PROVIDER_API_URLS allowlist.
//
// SECURITY: an apiKey enters buildRequest/buildKeyTestRequest and must appear
// ONLY in the returned headers — never in a URL, never in an error message.

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

/**
 * Two model slots, mirroring the CLI's haiku-distiller vs session-model split:
 * 'background' does the high-volume clip distillation (cheap model), 'chat'
 * answers the DevTools Brain tab (stronger model).
 */
export type ModelSlot = 'background' | 'chat';

export interface ProviderCallParams {
  prompt: string;
  model: string;
  maxTokens: number;
  /**
   * Caller wants strict JSON back. The Anthropic adapter ignores it — prompt
   * discipline plus the tolerant extractJson parser, exactly like the CLI's
   * `claude -p` path. Future adapters map it (OpenAI response_format, Gemini
   * responseMimeType) without an interface break.
   */
  jsonHint?: boolean;
}

export interface ProviderRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string; // pre-serialized JSON
}

export type ProviderErrorKind =
  | 'auth' //        401/403 — never retry; the user must fix the key
  | 'rate_limit' //  429 — retryable on a later tick
  | 'overloaded' //  529/5xx/network-shaped — retryable on a later tick
  | 'bad_request' // other 4xx — never retry; a bug or a bad model id
  | 'refusal' //     HTTP 200 with stop_reason 'refusal'
  | 'malformed' //   unparseable body — treat like a disconnect, never trust the wire
  | 'aborted'; //    caller-initiated stop (the user clicked Stop) — never retry

/** Messages are short and user-showable by construction — never the key, never a stack. */
export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded';
  }
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  /** Exact origin the manifest CSP + bundlePurity allowlist must carry. */
  apiHost: string;
  defaultModels: Record<ModelSlot, string>;
  /** Curated options for the settings selects; free-text override always allowed. */
  knownModels: string[];
  buildRequest(p: ProviderCallParams, apiKey: string): ProviderRequest;
  /** Returns the assistant text or throws ProviderError. */
  parseResponse(status: number, bodyText: string): string;
  /** Cheapest possible authenticated round trip, for the "Test connection" button. */
  buildKeyTestRequest(apiKey: string): ProviderRequest;
  /**
   * Tool-calling surface for the chat slot. Optional: a provider without an
   * implementation simply can't power the navigate tool yet — callers must
   * check for these before using them, never assume every adapter has them.
   */
  buildChatRequest?(p: ProviderChatCallParams, apiKey: string): ProviderRequest;
  /** Unlike parseResponse, does NOT throw on empty text — a pure tool_use turn has none. */
  parseChatResponse?(status: number, bodyText: string): ProviderChatResult;
  /**
   * Streaming counterpart of parseChatResponse: a pure state machine fed the
   * SSE body chunk by chunk. Optional like the other chat methods — a
   * provider without one simply can't stream; callers fall back to blocking.
   */
  createStreamParser?(): ProviderStreamParser;
}

export interface ProviderStreamParser {
  /** Feed one decoded chunk; returns the text deltas it revealed (often []). */
  feed(chunk: string): string[];
  /** Stream ended. Throws ProviderError (refusal/malformed/…) or returns the assembled result. */
  finish(): ProviderChatResult;
}

// ── tool-calling (chat slot only) ───────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatContentBlock[];
}

export interface ProviderChatCallParams {
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  tools?: ToolSpec[];
  /** Top-level system prompt, sent as a text block (not a messages[0] hack). */
  system?: string;
  /**
   * Place prompt-cache breakpoints: one on the system block (which caches
   * tools+system together — providers render tools → system → messages) and
   * one on the newest message's last content block, so each turn re-reads the
   * previous turn as cached prefix and writes one incremental entry. The
   * caller's `messages` array is NEVER mutated — breakpoints are stamped on a
   * copy — because next turn's cache hit depends on this turn's exact bytes.
   */
  cache?: boolean;
  /**
   * 'disabled' cuts adaptive-thinking latency on models that reason by
   * default (sonnet-5-class) — the web agent's tightly-steered tool loop
   * pays that tax every turn for no benefit. Omit to keep provider default.
   */
  thinking?: 'disabled' | 'adaptive';
  /** SSE streaming — pair the request with createStreamParser() to consume. */
  stream?: boolean;
}

export interface ProviderChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ProviderChatResult {
  /** Joined text blocks, '' if none (a pure tool_use turn has no text). */
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string | null;
  /** Token accounting when the provider reports it — how caching is verified. */
  usage?: ProviderChatUsage;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_HOST = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // The documented CORS opt-in for calling the Messages API from a browser
    // realm (what the official SDK's dangerouslyAllowBrowser sets). Harmless
    // server-side, required from the extension service worker.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

interface AnthropicErrorBody {
  type?: unknown;
  error?: { type?: unknown; message?: unknown };
}

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface AnthropicMessageBody {
  content?: AnthropicContentBlock[];
  stop_reason?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
}

function parseBody<T>(bodyText: string): T | null {
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return null;
  }
}

/**
 * Copy `messages` and stamp a cache_control breakpoint on the LAST content
 * block of the LAST message — the moving end of the cached prefix. String
 * content is normalized to a single text block first (a breakpoint needs a
 * block to sit on). Only the last message is deep-copied; earlier messages
 * are shared by reference, which is safe because nothing here mutates them —
 * and the caller's array is never touched, so next turn's request rebuilds
 * the exact same prefix bytes and hits the cache.
 */
function stampTailBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  const blocks: ChatContentBlock[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  if (blocks.length === 0) return messages;
  (blocks[blocks.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  out[out.length - 1] = { role: last.role, content: blocks };
  return out;
}

/** The envelope every /v1/messages request shares — only the body differs between buildRequest and buildChatRequest. */
function anthropicMessagesRequest(body: Record<string, unknown>, apiKey: string): ProviderRequest {
  return {
    url: `${ANTHROPIC_HOST}/v1/messages`,
    method: 'POST',
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify(body),
  };
}

/** Shared with parseChatResponse — throws on every real failure status, same mapping either way. */
function throwOnErrorStatus(status: number, bodyText: string): void {
  if (status >= 200 && status < 300) return;
  const parsed = parseBody<AnthropicErrorBody>(bodyText);
  const errType = typeof parsed?.error?.type === 'string' ? parsed.error.type : '';
  const errMessage =
    typeof parsed?.error?.message === 'string' && parsed.error.message
      ? parsed.error.message.slice(0, 200)
      : `provider returned HTTP ${status}`;
  if (status === 401 || status === 403) throw new ProviderError('auth', 'invalid or unauthorized API key', status);
  if (status === 429) throw new ProviderError('rate_limit', 'provider rate limit hit', status);
  if (status === 529 || status >= 500 || errType === 'overloaded_error')
    throw new ProviderError('overloaded', 'provider overloaded or unavailable', status);
  throw new ProviderError('bad_request', errMessage, status);
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  apiHost: ANTHROPIC_HOST,
  defaultModels: { background: 'claude-haiku-4-5', chat: 'claude-sonnet-5' },
  knownModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],

  buildRequest(p: ProviderCallParams, apiKey: string): ProviderRequest {
    return anthropicMessagesRequest(
      { model: p.model, max_tokens: p.maxTokens, messages: [{ role: 'user', content: p.prompt }] },
      apiKey,
    );
  },

  parseResponse(status: number, bodyText: string): string {
    throwOnErrorStatus(status, bodyText);
    const parsed = parseBody<AnthropicMessageBody>(bodyText);
    if (!parsed || !Array.isArray(parsed.content))
      throw new ProviderError('malformed', 'provider returned an unreadable response', status);
    if (parsed.stop_reason === 'refusal')
      throw new ProviderError('refusal', 'the model declined to answer this request', status);
    const text = parsed.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!text) throw new ProviderError('malformed', 'provider returned an empty response', status);
    // stop_reason 'max_tokens' still returns the (truncated) text — the tolerant
    // clip parser and prose chat both degrade gracefully, matching CLI behavior.
    return text;
  },

  buildKeyTestRequest(apiKey: string): ProviderRequest {
    return anthropicMessagesRequest({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }, apiKey);
  },

  buildChatRequest(p: ProviderChatCallParams, apiKey: string): ProviderRequest {
    const cacheOn = p.cache === true;
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: p.maxTokens,
      messages: cacheOn ? stampTailBreakpoint(p.messages) : p.messages,
    };
    if (p.tools && p.tools.length > 0) body.tools = p.tools;
    if (p.system !== undefined) {
      // Block form (not a bare string) so the cache breakpoint has somewhere
      // to live. Anthropic renders tools → system → messages, so this one
      // breakpoint caches the tool schemas AND the system prompt together.
      const block: Record<string, unknown> = { type: 'text', text: p.system };
      if (cacheOn) block.cache_control = { type: 'ephemeral' };
      body.system = [block];
    }
    if (p.thinking === 'disabled') body.thinking = { type: 'disabled' };
    if (p.stream) body.stream = true;
    return anthropicMessagesRequest(body, apiKey);
  },

  createStreamParser(): ProviderStreamParser {
    return createAnthropicStreamParser();
  },

  parseChatResponse(status: number, bodyText: string): ProviderChatResult {
    throwOnErrorStatus(status, bodyText);
    const parsed = parseBody<AnthropicMessageBody>(bodyText);
    if (!parsed || !Array.isArray(parsed.content))
      throw new ProviderError('malformed', 'provider returned an unreadable response', status);
    if (parsed.stop_reason === 'refusal')
      throw new ProviderError('refusal', 'the model declined to answer this request', status);
    const text = parsed.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const toolCalls = parsed.content
      .filter((b) => b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
      .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input }));
    const u = parsed.usage;
    const usage: ProviderChatUsage | undefined =
      u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
        ? {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            ...(typeof u.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
            ...(typeof u.cache_creation_input_tokens === 'number'
              ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
              : {}),
          }
        : undefined;
    return { text, toolCalls, stopReason: typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null, usage };
  },
};

// ── Anthropic SSE stream parser ─────────────────────────────────────────────
//
// Hand-rolled (no SDK, same rule as the rest of this module): a pure state
// machine over the /v1/messages event stream. Events arrive as SSE frames
// ("event: X\ndata: {json}\n\n") that can be split ANYWHERE across network
// chunks — feed() buffers until a complete frame is available. The shapes it
// must handle: message_start (input-side usage), content_block_start (text /
// tool_use), content_block_delta (text_delta streamed out as it lands;
// input_json_delta accumulated as raw fragments), content_block_stop (the
// accumulated JSON parses HERE, not per-fragment), message_delta (stop_reason
// + output usage), error (mapped to ProviderError), ping (ignored).

interface AnthropicStreamEventBody {
  type?: unknown;
  message?: { usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } };
  index?: unknown;
  content_block?: { type?: unknown; id?: unknown; name?: unknown };
  delta?: { type?: unknown; text?: unknown; partial_json?: unknown; stop_reason?: unknown };
  usage?: { output_tokens?: unknown };
  error?: { type?: unknown; message?: unknown };
}

export function createAnthropicStreamParser(): ProviderStreamParser {
  let buffer = '';
  let text = '';
  let stopReason: string | null = null;
  let started = false;
  let error: ProviderError | null = null;
  const usage: ProviderChatUsage = { input_tokens: 0, output_tokens: 0 };
  let sawUsage = false;
  const toolCalls: ProviderChatResult['toolCalls'] = [];
  const openBlocks = new Map<number, { kind: 'text' } | { kind: 'tool_use'; id: string; name: string; json: string }>();

  function handle(body: AnthropicStreamEventBody): string | null {
    switch (body.type) {
      case 'message_start': {
        started = true;
        const u = body.message?.usage;
        if (u && typeof u.input_tokens === 'number') {
          sawUsage = true;
          usage.input_tokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        }
        return null;
      }
      case 'content_block_start': {
        const idx = typeof body.index === 'number' ? body.index : -1;
        const block = body.content_block;
        if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          openBlocks.set(idx, { kind: 'tool_use', id: block.id, name: block.name, json: '' });
        } else if (block?.type === 'text') {
          openBlocks.set(idx, { kind: 'text' });
        }
        return null;
      }
      case 'content_block_delta': {
        const idx = typeof body.index === 'number' ? body.index : -1;
        const delta = body.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          return delta.text;
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const open = openBlocks.get(idx);
          if (open?.kind === 'tool_use') open.json += delta.partial_json;
        }
        return null; // thinking_delta etc.: not surfaced
      }
      case 'content_block_stop': {
        const idx = typeof body.index === 'number' ? body.index : -1;
        const open = openBlocks.get(idx);
        openBlocks.delete(idx);
        if (open?.kind === 'tool_use') {
          // The accumulated fragments parse only now, as one document. An
          // empty accumulation is a legal no-argument call ({}).
          const parsed = parseBody<unknown>(open.json || '{}');
          if (parsed === null) error ??= new ProviderError('malformed', 'provider streamed unreadable tool input');
          else toolCalls.push({ id: open.id, name: open.name, input: parsed });
        }
        return null;
      }
      case 'message_delta': {
        if (typeof body.delta?.stop_reason === 'string') stopReason = body.delta.stop_reason;
        if (typeof body.usage?.output_tokens === 'number') usage.output_tokens = body.usage.output_tokens;
        return null;
      }
      case 'error': {
        const errType = typeof body.error?.type === 'string' ? body.error.type : '';
        const message =
          typeof body.error?.message === 'string' && body.error.message
            ? body.error.message.slice(0, 200)
            : 'provider stream error';
        error ??=
          errType === 'overloaded_error'
            ? new ProviderError('overloaded', 'provider overloaded or unavailable')
            : new ProviderError('bad_request', message);
        return null;
      }
      default:
        return null; // message_stop, ping, unknown future events
    }
  }

  return {
    feed(chunk: string): string[] {
      buffer += chunk;
      const deltas: string[] = [];
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m) break;
        const frame = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const body = parseBody<AnthropicStreamEventBody>(data);
        if (!body) {
          error ??= new ProviderError('malformed', 'provider streamed an unreadable event');
          continue;
        }
        const delta = handle(body);
        if (delta) deltas.push(delta);
      }
      return deltas;
    },

    finish(): ProviderChatResult {
      if (error) throw error;
      if (!started) throw new ProviderError('malformed', 'provider returned an unreadable response');
      if (stopReason === 'refusal') throw new ProviderError('refusal', 'the model declined to answer this request');
      return { text, toolCalls, stopReason, ...(sawUsage ? { usage } : {}) };
    },
  };
}

// ── registry ─────────────────────────────────────────────────────────────────

export const PROVIDERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
};

/** Drives the provider-shaped settings UI from day one. */
export const PROVIDER_CHOICES: ReadonlyArray<{ id: ProviderId; label: string; available: boolean }> = [
  { id: 'anthropic', label: 'Anthropic', available: true },
  { id: 'openai', label: 'OpenAI', available: false },
  { id: 'gemini', label: 'Google Gemini', available: false },
];
