import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_CHOICES,
  ProviderError,
  anthropicAdapter,
  createAnthropicStreamParser,
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

describe('anthropic adapter — buildChatRequest', () => {
  it('carries a full message array and omits tools when none are given', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const req = anthropicAdapter.buildChatRequest!({ messages, model: 'claude-sonnet-5', maxTokens: 4096 }, 'sk-ant-test-key');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({ model: 'claude-sonnet-5', max_tokens: 4096, messages });
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.body).not.toContain('sk-ant');
  });

  it('serializes the tools array when provided', () => {
    const tools = [{ name: 'navigate', description: 'open a page', input_schema: { type: 'object' } }];
    const req = anthropicAdapter.buildChatRequest!(
      { messages: [{ role: 'user', content: 'hi' }], model: 'claude-sonnet-5', maxTokens: 4096, tools },
      'k',
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.tools).toEqual(tools);
  });

  it('passes tool_use/tool_result content blocks through untouched', () => {
    const messages = [
      { role: 'user' as const, content: 'open developer.chrome.com' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 't1', name: 'navigate', input: { url: 'https://developer.chrome.com' } }],
      },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'opened' }] },
    ];
    const req = anthropicAdapter.buildChatRequest!({ messages, model: 'claude-sonnet-5', maxTokens: 4096 }, 'k');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.messages).toEqual(messages);
  });
});

describe('anthropic adapter — buildChatRequest system/cache/thinking', () => {
  const goal = { role: 'user' as const, content: 'GOAL: do the thing' };

  it('renders system as a block array with a cache breakpoint when cache is on', () => {
    const req = anthropicAdapter.buildChatRequest!(
      { messages: [goal], model: 'claude-sonnet-5', maxTokens: 2048, system: 'steer', cache: true },
      'k',
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.system).toEqual([{ type: 'text', text: 'steer', cache_control: { type: 'ephemeral' } }]);
  });

  it('renders system without a breakpoint when cache is off', () => {
    const req = anthropicAdapter.buildChatRequest!(
      { messages: [goal], model: 'claude-sonnet-5', maxTokens: 2048, system: 'steer' },
      'k',
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.system).toEqual([{ type: 'text', text: 'steer' }]);
    expect(req.body).not.toContain('cache_control');
  });

  it('stamps the moving breakpoint on the LAST content block of the LAST message, normalizing string content', () => {
    const req = anthropicAdapter.buildChatRequest!(
      { messages: [goal], model: 'claude-sonnet-5', maxTokens: 2048, system: 'steer', cache: true },
      'k',
    );
    const body = JSON.parse(req.body) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'GOAL: do the thing', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('stamps only the final block of a multi-block tail — exactly two breakpoints total', () => {
    const messages = [
      goal,
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'read_page', input: {} }] },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 't1', content: 'snapshot' },
          { type: 'text' as const, text: 'continue' },
        ],
      },
    ];
    const req = anthropicAdapter.buildChatRequest!(
      { messages, model: 'claude-sonnet-5', maxTokens: 2048, system: 'steer', cache: true },
      'k',
    );
    const body = JSON.parse(req.body) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const tail = body.messages[2]!.content;
    expect(tail[0]!.cache_control).toBeUndefined();
    expect(tail[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect((req.body.match(/cache_control/g) ?? []).length).toBe(2);
  });

  it('NEVER mutates the caller’s messages — next turn’s prefix bytes depend on it', () => {
    const messages = [{ role: 'user' as const, content: 'GOAL: x' }];
    const before = JSON.stringify(messages);
    anthropicAdapter.buildChatRequest!({ messages, model: 'claude-sonnet-5', maxTokens: 2048, system: 's', cache: true }, 'k');
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("thinking 'disabled' is sent; 'adaptive' and absent both omit the field (provider default)", () => {
    const on = anthropicAdapter.buildChatRequest!(
      { messages: [goal], model: 'claude-sonnet-5', maxTokens: 2048, thinking: 'disabled' },
      'k',
    );
    expect((JSON.parse(on.body) as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });
    const adaptive = anthropicAdapter.buildChatRequest!(
      { messages: [goal], model: 'claude-sonnet-5', maxTokens: 2048, thinking: 'adaptive' },
      'k',
    );
    expect(adaptive.body).not.toContain('thinking');
  });
});

describe('anthropic adapter — parseChatResponse', () => {
  it('parses a plain text-only response the same as parseResponse (regression)', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' });
    expect(anthropicAdapter.parseChatResponse!(200, body)).toEqual({ text: 'hello', toolCalls: [], stopReason: 'end_turn' });
  });

  it('does NOT throw on empty text for a pure tool_use turn', () => {
    const body = JSON.stringify({
      content: [{ type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://developer.chrome.com' } }],
      stop_reason: 'tool_use',
    });
    expect(anthropicAdapter.parseChatResponse!(200, body)).toEqual({
      text: '',
      toolCalls: [{ id: 't1', name: 'navigate', input: { url: 'https://developer.chrome.com' } }],
      stopReason: 'tool_use',
    });
  });

  it('parses a mixed text + tool_use response', () => {
    const body = JSON.stringify({
      content: [
        { type: 'text', text: 'sure, opening it' },
        { type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://developer.chrome.com' } },
      ],
      stop_reason: 'tool_use',
    });
    const result = anthropicAdapter.parseChatResponse!(200, body);
    expect(result.text).toBe('sure, opening it');
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'navigate', input: { url: 'https://developer.chrome.com' } }]);
  });

  it('maps error statuses identically to parseResponse', () => {
    const err = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'boom' } });
    try {
      anthropicAdapter.parseChatResponse!(401, err);
      throw new Error('unreachable');
    } catch (e) {
      expect((e as ProviderError).kind).toBe('auth');
    }
  });

  it('still throws refusal and malformed the same way', () => {
    const refusal = JSON.stringify({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' });
    expect(() => anthropicAdapter.parseChatResponse!(200, refusal)).toThrow();
    expect(() => anthropicAdapter.parseChatResponse!(200, 'not json')).toThrow();
  });

  it('surfaces usage incl. cache counters when present — how caching gets verified', () => {
    const body = JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 1400, cache_creation_input_tokens: 80 },
    });
    expect(anthropicAdapter.parseChatResponse!(200, body).usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 1400,
      cache_creation_input_tokens: 80,
    });
  });

  it('omits usage when the wire shape is off — never trust the wire', () => {
    const body = JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 'twelve' } });
    expect(anthropicAdapter.parseChatResponse!(200, body).usage).toBeUndefined();
  });
});

describe('anthropic adapter — createAnthropicStreamParser', () => {
  const frame = (type: string, body: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

  function fullStream(): string {
    return [
      frame('message_start', {
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 20 } },
      }),
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'reading ' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'the page' } }),
      frame('content_block_stop', { index: 0 }),
      frame('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read_page', input: {} } }),
      frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"mo' } }),
      frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'de":"text"}' } }),
      frame('content_block_stop', { index: 1 }),
      frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
      frame('message_stop', {}),
    ].join('');
  }

  it('assembles text, tool input from JSON fragments, stop_reason, and usage', () => {
    const parser = createAnthropicStreamParser();
    const deltas = parser.feed(fullStream());
    expect(deltas).toEqual(['reading ', 'the page']);
    expect(parser.finish()).toEqual({
      text: 'reading the page',
      toolCalls: [{ id: 't1', name: 'read_page', input: { mode: 'text' } }],
      stopReason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 900, cache_creation_input_tokens: 20 },
    });
  });

  it('handles frames split at ARBITRARY byte boundaries across chunks', () => {
    const stream = fullStream();
    for (const size of [1, 3, 7, 50]) {
      const parser = createAnthropicStreamParser();
      const deltas: string[] = [];
      for (let i = 0; i < stream.length; i += size) deltas.push(...parser.feed(stream.slice(i, i + size)));
      expect(deltas.join('')).toBe('reading the page');
      expect(parser.finish().toolCalls).toEqual([{ id: 't1', name: 'read_page', input: { mode: 'text' } }]);
    }
  });

  it('handles CRLF line endings', () => {
    const parser = createAnthropicStreamParser();
    parser.feed(fullStream().replace(/\n/g, '\r\n'));
    expect(parser.finish().text).toBe('reading the page');
  });

  it('a tool_use with no input fragments parses as {}', () => {
    const parser = createAnthropicStreamParser();
    parser.feed(
      frame('message_start', { message: {} }) +
        frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read_page' } }) +
        frame('content_block_stop', { index: 0 }) +
        frame('message_stop', {}),
    );
    expect(parser.finish().toolCalls).toEqual([{ id: 't1', name: 'read_page', input: {} }]);
  });

  it('an error event maps to a ProviderError on finish', () => {
    const parser = createAnthropicStreamParser();
    parser.feed(frame('message_start', { message: {} }) + frame('error', { error: { type: 'overloaded_error', message: 'x' } }));
    expect(() => parser.finish()).toThrowError(expect.objectContaining({ kind: 'overloaded' }));
  });

  it('a truncated / never-started stream is malformed, never a silent empty result', () => {
    const parser = createAnthropicStreamParser();
    parser.feed('data: {"type":"conten'); // no complete frame ever
    expect(() => parser.finish()).toThrowError(expect.objectContaining({ kind: 'malformed' }));
  });

  it('a refusal stop_reason throws on finish, matching the blocking parser', () => {
    const parser = createAnthropicStreamParser();
    parser.feed(frame('message_start', { message: {} }) + frame('message_delta', { delta: { stop_reason: 'refusal' } }));
    expect(() => parser.finish()).toThrowError(expect.objectContaining({ kind: 'refusal' }));
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
