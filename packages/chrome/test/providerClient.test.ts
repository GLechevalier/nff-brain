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
import { MAX_CHAT_TOOL_TURNS, runChatWithTools, type ToolExecutor } from '../src/providerClient.js';

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
});
