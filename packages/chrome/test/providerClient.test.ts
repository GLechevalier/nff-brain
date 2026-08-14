import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The loop logic in runChatWithTools is worth testing directly (unlike most
// of this file's chrome/fetch-touching siblings, which stay pure-half-only
// per the bundlePurity convention) because it's real control flow — a turn
// cap and a tool dispatch table — not just glue. storage.js (chrome.storage)
// and global fetch are the only two impure seams, so both are faked here.

vi.mock('../src/storage.js', () => ({
  getProviderSettings: vi.fn(),
  setProviderSettings: vi.fn(),
}));

import { getProviderSettings } from '../src/storage.js';
import {
  MAX_CHAT_TOOL_TURNS,
  SNAPSHOT_STUB_NOTE,
  TOOL_RESULT_MAX_CHARS,
  compactSupersededSnapshots,
  runChatWithTools,
  type ToolExecutor,
} from '../src/providerClient.js';
import { ProviderError } from '@nff-brain/core/provider';
import type { ChatMessage } from '@nff-brain/core/provider';

const SETTINGS = {
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
  models: { background: 'claude-haiku-4-5', chat: 'claude-sonnet-5' },
  addedAt: new Date(0).toISOString(),
  lastTest: null,
};

function fetchOk(bodyJson: unknown): { status: number; text: () => Promise<string> } {
  return { status: 200, text: async () => JSON.stringify(bodyJson) };
}

function textResponse(text: string, stopReason = 'end_turn') {
  return fetchOk({ content: [{ type: 'text', text }], stop_reason: stopReason });
}

function toolUseResponse(id: string, name: string, input: unknown) {
  return fetchOk({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
}

describe('runChatWithTools', () => {
  beforeEach(() => {
    vi.mocked(getProviderSettings).mockResolvedValue(SETTINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns null when no provider is configured', async () => {
    vi.mocked(getProviderSettings).mockResolvedValue(null);
    expect(await runChatWithTools('hi', [])).toBeNull();
  });

  it('resolves in a single round trip when the model calls no tool', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('hello there'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await runChatWithTools('hi', [])).toEqual({ answer: 'hello there', toolEvents: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('executes a matched tool and resolves after the follow-up turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('t1', 'navigate', { url: 'https://developer.chrome.com' }))
      .mockResolvedValueOnce(textResponse('opened it for you'));
    vi.stubGlobal('fetch', fetchMock);

    const run = vi.fn().mockResolvedValue({ ok: true, resultText: 'opened https://developer.chrome.com/ in a new tab' });
    const executor: ToolExecutor = { spec: { name: 'navigate', description: 'x', input_schema: {} }, run };

    const result = await runChatWithTools('open developer.chrome.com', [executor]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith({ url: 'https://developer.chrome.com' });
    expect(result).toEqual({
      answer: 'opened it for you',
      toolEvents: [{ name: 'navigate', ok: true, summary: 'opened https://developer.chrome.com/ in a new tab' }],
    });
  });

  it('never sends more than MAX_CHAT_TOOL_TURNS requests, even if the model keeps calling the tool', async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse('t1', 'navigate', { url: 'https://developer.chrome.com' }));
    vi.stubGlobal('fetch', fetchMock);

    const run = vi.fn().mockResolvedValue({ ok: true, resultText: 'opened' });
    const executor: ToolExecutor = { spec: { name: 'navigate', description: 'x', input_schema: {} }, run };

    const result = await runChatWithTools('keep going forever', [executor]);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_CHAT_TOOL_TURNS);
    expect(result).not.toBeNull();
  });

  it('reports an unrecognized tool name as a failed call instead of crashing the loop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('t1', 'not_registered', {}))
      .mockResolvedValueOnce(textResponse('done'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runChatWithTools('do something', []);

    expect(result?.toolEvents).toEqual([{ name: 'not_registered', ok: false, summary: 'unknown tool' }]);
    expect(result?.answer).toBe('done');
  });

  it('honors a raised maxTurns for the web-agent loop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse('t1', 'navigate', { url: 'https://x.com' }));
    vi.stubGlobal('fetch', fetchMock);
    const executor: ToolExecutor = {
      spec: { name: 'navigate', description: 'x', input_schema: {} },
      run: vi.fn().mockResolvedValue({ ok: true, resultText: 'ok' }),
    };

    await runChatWithTools('go', [executor], { maxTurns: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stops early when onTurn returns false (Stop / budget)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse('t1', 'navigate', { url: 'https://x.com' }));
    vi.stubGlobal('fetch', fetchMock);
    const executor: ToolExecutor = {
      spec: { name: 'navigate', description: 'x', input_schema: {} },
      run: vi.fn().mockResolvedValue({ ok: true, resultText: 'ok' }),
    };

    const onTurn = vi.fn().mockReturnValue(false); // stop after the first turn
    const result = await runChatWithTools('go', [executor], { maxTurns: 10, onTurn });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });

  it('resumes from priorMessages instead of the initial prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('resumed'));
    vi.stubGlobal('fetch', fetchMock);

    await runChatWithTools('IGNORED', [], {
      priorMessages: [
        { role: 'user', content: 'earlier goal' },
        { role: 'assistant', content: 'working' },
        { role: 'user', content: 'continue' },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].content).toBe('earlier goal');
  });

  it('threads system/thinking/maxTokens into every request, with caching on', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('done'));
    vi.stubGlobal('fetch', fetchMock);

    await runChatWithTools('go', [], { system: 'steering rules', thinking: 'disabled', maxTokens: 2048 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.system).toEqual([{ type: 'text', text: 'steering rules', cache_control: { type: 'ephemeral' } }]);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(2048);
  });

  it('a plain chat call (no system) keeps the pre-cache request shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('hi'));
    vi.stubGlobal('fetch', fetchMock);

    await runChatWithTools('hi', []);
    const raw = fetchMock.mock.calls[0]![1].body as string;
    expect(raw).not.toContain('cache_control');
    expect(raw).not.toContain('"system"');
  });

  it("an aborted signal surfaces as ProviderError 'aborted' — Stop preempts the model call", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        controller.abort();
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = runChatWithTools('go', [], { signal: controller.signal });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.kind === 'aborted');
  });

  it('clips oversized tool results at APPEND time to TOOL_RESULT_MAX_CHARS', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('t1', 'read_page', {}))
      .mockResolvedValueOnce(textResponse('done'));
    vi.stubGlobal('fetch', fetchMock);
    const executor: ToolExecutor = {
      spec: { name: 'read_page', description: 'x', input_schema: {} },
      run: vi.fn().mockResolvedValue({ ok: true, resultText: 'x'.repeat(20_000) }),
    };

    await runChatWithTools('go', [executor], { maxTurns: 3 });
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body);
    const resultBlock = secondBody.messages.at(-1).content[0];
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.content).toHaveLength(TOOL_RESULT_MAX_CHARS);
  });

  it('compacts the SUPERSEDED snapshot once a newer one lands (compactToolNames)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('t1', 'read_page', {}))
      .mockResolvedValueOnce(toolUseResponse('t2', 'read_page', {}))
      .mockResolvedValueOnce(textResponse('done'));
    vi.stubGlobal('fetch', fetchMock);
    const executor: ToolExecutor = {
      spec: { name: 'read_page', description: 'x', input_schema: {} },
      run: vi.fn().mockResolvedValue({ ok: true, resultText: 'e1 button · '.repeat(200) }),
    };

    await runChatWithTools('go', [executor], { maxTurns: 4, compactToolNames: ['read_page'] });
    const thirdBody = JSON.parse(fetchMock.mock.calls[2]![1].body);
    const results = (thirdBody.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'user' && Array.isArray(m.content))
      .flatMap((m) => m.content as Array<{ type: string; content: string }>)
      .filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toContain(SNAPSHOT_STUB_NOTE.trim().slice(1, 20));
    expect(results[0]!.content.length).toBeLessThan(500);
    expect(results[1]!.content.length).toBeGreaterThan(1000); // newest stays full
  });
});

describe('runChatWithTools — streaming', () => {
  beforeEach(() => {
    vi.mocked(getProviderSettings).mockResolvedValue(SETTINGS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const frame = (type: string, body: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

  function sseBody(frames: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(frames));
        c.close();
      },
    });
  }

  it('opts into SSE (stream:true) and surfaces deltas before the turn settles', async () => {
    const frames =
      frame('message_start', { message: {} }) +
      frame('content_block_start', { index: 0, content_block: { type: 'text' } }) +
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello ' } }) +
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'there' } }) +
      frame('content_block_stop', { index: 0 }) +
      frame('message_delta', { delta: { stop_reason: 'end_turn' } }) +
      frame('message_stop', {});
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, body: sseBody(frames) });
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const result = await runChatWithTools('hi', [], { onAssistantTextDelta: (t) => deltas.push(t) });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).stream).toBe(true);
    expect(deltas).toEqual(['hello ', 'there']);
    expect(result).toEqual({ answer: 'hello there', toolEvents: [] });
  });

  it('a non-2xx streaming request still maps through the blocking error path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 429, body: null, text: async () => '{}' }));
    await expect(runChatWithTools('hi', [], { onAssistantTextDelta: () => undefined })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.kind === 'rate_limit',
    );
  });

  it("aborting mid-stream surfaces as 'aborted', not a stall", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    // A body that never produces a chunk — reader.read() hangs until the
    // 30s idle timer fires; with the signal already aborted by then, the
    // failure must classify as the user's Stop, not a provider stall.
    const hanging = new ReadableStream<Uint8Array>({ start: () => undefined });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, body: hanging }));

    const p = runChatWithTools('hi', [], { onAssistantTextDelta: () => undefined, signal: controller.signal });
    const settled = expect(p).rejects.toSatisfy((e: unknown) => e instanceof ProviderError && e.kind === 'aborted');
    controller.abort();
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;
  });
});

describe('compactSupersededSnapshots', () => {
  const bigSnapshot = (tag: string) => `${tag} ` + 'element row · '.repeat(100);

  function history(): ChatMessage[] {
    return [
      { role: 'user', content: 'GOAL: x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'read_page', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: bigSnapshot('first') }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's2', name: 'read_page', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's2', content: bigSnapshot('second') }] },
    ];
  }

  it('stubs every snapshot except the newest', () => {
    const messages = history();
    compactSupersededSnapshots(messages, new Set(['s1', 's2']));
    const first = (messages[2]!.content as Array<{ content: string }>)[0]!;
    const second = (messages[4]!.content as Array<{ content: string }>)[0]!;
    expect(first.content).toContain('[stale snapshot truncated');
    expect(second.content).toBe(bigSnapshot('second'));
  });

  it('is idempotent — a second pass is byte-stable (the cache invariant)', () => {
    const messages = history();
    compactSupersededSnapshots(messages, new Set(['s1', 's2']));
    const after = JSON.stringify(messages);
    compactSupersededSnapshots(messages, new Set(['s1', 's2']));
    expect(JSON.stringify(messages)).toBe(after);
  });

  it('touches ONLY superseded snapshot blocks — everything else keeps its bytes', () => {
    const messages = history();
    const beforeOthers = JSON.stringify([messages[0], messages[1], messages[3], messages[4]]);
    compactSupersededSnapshots(messages, new Set(['s1', 's2']));
    expect(JSON.stringify([messages[0], messages[1], messages[3], messages[4]])).toBe(beforeOthers);
  });

  it('ignores tool_results whose ids are not tracked snapshots', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other', content: bigSnapshot('untracked') }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's2', content: bigSnapshot('tracked') }] },
    ];
    compactSupersededSnapshots(messages, new Set(['s2']));
    expect((messages[0]!.content as Array<{ content: string }>)[0]!.content).toBe(bigSnapshot('untracked'));
  });
});
