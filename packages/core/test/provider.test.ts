import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_CHOICES,
  ProviderError,
  anthropicAdapter,
} from '../src/provider.js';

// Pure adapter tests — zero network. The fetch half lives in the chrome
// package and is covered by its structural tests + the manual smoke checklist.

describe('anthropic adapter — buildRequest', () => {
  const req = anthropicAdapter.buildRequest(
    { prompt: 'hello there', model: 'claude-haiku-4-5', maxTokens: 4096, jsonHint: true },
    'sk-ant-test-key',
  );

  it('targets the messages endpoint on the pinned host', () => {
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.method).toBe('POST');
  });

  it('carries exactly the four required headers, key only in x-api-key', () => {
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test-key',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(req.url).not.toContain('sk-ant');
    expect(req.body).not.toContain('sk-ant');
  });

  it('propagates model, max_tokens and the prompt as a single user message', () => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hello there' }],
    });
  });
});

describe('anthropic adapter — parseResponse', () => {
  const err = (status: number, type: string, message = 'boom'): string =>
    JSON.stringify({ type: 'error', error: { type, message } });

  function kindOf(status: number, body: string): { kind: string; retryable: boolean } {
    try {
      anthropicAdapter.parseResponse(status, body);
    } catch (e) {
      const p = e as ProviderError;
      expect(p).toBeInstanceOf(ProviderError);
      return { kind: p.kind, retryable: p.retryable };
    }
    throw new Error('expected a ProviderError');
  }

  it('concatenates multiple text blocks and ignores non-text blocks', () => {
    const body = JSON.stringify({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'tool_use', id: 'x' },
        { type: 'text', text: 'part two' },
      ],
      stop_reason: 'end_turn',
    });
    expect(anthropicAdapter.parseResponse(200, body)).toBe('part one part two');
  });

  it('returns truncated text on stop_reason max_tokens', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: 'cut off mid' }], stop_reason: 'max_tokens' });
    expect(anthropicAdapter.parseResponse(200, body)).toBe('cut off mid');
  });

  it('maps 401 and 403 to auth (never retryable)', () => {
    expect(kindOf(401, err(401, 'authentication_error'))).toEqual({ kind: 'auth', retryable: false });
    expect(kindOf(403, err(403, 'permission_error'))).toEqual({ kind: 'auth', retryable: false });
  });

  it('maps 429 to rate_limit (retryable)', () => {
    expect(kindOf(429, err(429, 'rate_limit_error'))).toEqual({ kind: 'rate_limit', retryable: true });
  });

  it('maps 529 and 500 to overloaded (retryable)', () => {
    expect(kindOf(529, err(529, 'overloaded_error'))).toEqual({ kind: 'overloaded', retryable: true });
    expect(kindOf(500, err(500, 'api_error'))).toEqual({ kind: 'overloaded', retryable: true });
  });

  it('maps other 4xx to bad_request with the server message', () => {
    try {
      anthropicAdapter.parseResponse(400, err(400, 'invalid_request_error', 'model not found'));
      throw new Error('unreachable');
    } catch (e) {
      const p = e as ProviderError;
      expect(p.kind).toBe('bad_request');
      expect(p.retryable).toBe(false);
      expect(p.message).toBe('model not found');
    }
  });

  it('maps a refusal stop_reason to refusal', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' });
    expect(kindOf(200, body).kind).toBe('refusal');
  });

  it('maps garbage and empty bodies to malformed', () => {
    expect(kindOf(200, 'not json at all').kind).toBe('malformed');
    expect(kindOf(200, JSON.stringify({ content: [] })).kind).toBe('malformed');
    // an unparseable ERROR body still maps by status, not to malformed
    expect(kindOf(429, '<busy>').kind).toBe('rate_limit');
  });

  it('auth errors never echo the server message (could be key-adjacent)', () => {
    try {
      anthropicAdapter.parseResponse(401, err(401, 'authentication_error', 'bad key sk-ant-xyz'));
      throw new Error('unreachable');
    } catch (e) {
      expect((e as ProviderError).message).not.toContain('sk-ant');
    }
  });
});

describe('anthropic adapter — key test request', () => {
  it('is the cheapest authenticated round trip: haiku, max_tokens 1', () => {
    const req = anthropicAdapter.buildKeyTestRequest('k');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(1);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('registry', () => {
  it('ships anthropic only, with the two-slot defaults', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['anthropic']);
    expect(anthropicAdapter.defaultModels).toEqual({
      background: 'claude-haiku-4-5',
      chat: 'claude-sonnet-5',
    });
  });

  it('lists all three providers for the UI, only anthropic available', () => {
    expect(PROVIDER_CHOICES.map((c) => c.id)).toEqual(['anthropic', 'openai', 'gemini']);
    expect(PROVIDER_CHOICES.filter((c) => c.available).map((c) => c.id)).toEqual(['anthropic']);
  });
});
