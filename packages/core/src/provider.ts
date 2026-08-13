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
  | 'malformed'; //  unparseable body — treat like a disconnect, never trust the wire

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

interface AnthropicMessageBody {
  content?: Array<{ type?: unknown; text?: unknown }>;
  stop_reason?: unknown;
}

function parseBody<T>(bodyText: string): T | null {
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return null;
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  apiHost: ANTHROPIC_HOST,
  defaultModels: { background: 'claude-haiku-4-5', chat: 'claude-sonnet-5' },
  knownModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],

  buildRequest(p: ProviderCallParams, apiKey: string): ProviderRequest {
    return {
      url: `${ANTHROPIC_HOST}/v1/messages`,
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model: p.model,
        max_tokens: p.maxTokens,
        messages: [{ role: 'user', content: p.prompt }],
      }),
    };
  },

  parseResponse(status: number, bodyText: string): string {
    if (status < 200 || status >= 300) {
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
    return {
      url: `${ANTHROPIC_HOST}/v1/messages`,
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    };
  },
};

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
