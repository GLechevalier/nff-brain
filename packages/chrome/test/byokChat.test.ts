import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The BYOK chat leg (byokChat.ts) — resurrected from the deleted
// standalone.ts localChat. The provider fetch and the two chrome-touching
// seams (storage.ts, navigateTool.ts) are faked; everything else runs real,
// including buildChatPrompt/cleanChatAnswer and the runChatWithTools loop.

vi.mock('../src/storage.js', () => ({
  getProviderSettings: vi.fn(),
  setProviderSettings: vi.fn(),
  // brainStore's seam — default: no local brain saved yet.
  getBrain: vi.fn(async () => null),
  setBrain: vi.fn(),
}));
vi.mock('../src/navigateTool.js', () => ({
  NAVIGATE_TOOL_SPEC: { name: 'navigate', description: 'open a page', input_schema: { type: 'object' } },
  executeNavigate: vi.fn(),
}));

import { getProviderSettings } from '../src/storage.js';
import { executeNavigate } from '../src/navigateTool.js';
import { byokChatAsk } from '../src/byokChat.js';

const SETTINGS = {
  provider: 'anthropic' as const,
  apiKey: 'sk-ant-test',
  models: { background: 'claude-haiku-4-5', chat: 'claude-sonnet-5' },
  addedAt: new Date(0).toISOString(),
  lastTest: null,
};

function fetchOk(bodyJson: unknown) {
  return { status: 200, text: async () => JSON.stringify(bodyJson) };
}

describe('byokChatAsk', () => {
  beforeEach(() => {
    vi.mocked(getProviderSettings).mockResolvedValue(SETTINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('without a configured key returns a pointer at Settings, never a throw', async () => {
    vi.mocked(getProviderSettings).mockResolvedValue(null);
    const reply = await byokChatAsk('hi', [], 1);
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toContain('API key');
  });

  it('answers a plain question with the model text (no sources yet in v1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fetchOk({ content: [{ type: 'text', text: 'plain answer' }], stop_reason: 'end_turn' })),
    );
    const reply = await byokChatAsk('what is x?', [], 1);
    expect(reply).toEqual({ type: 'chatAnswer', answer: 'plain answer', sources: [] });
  });

  it('appends a confirmation note when the navigate tool ran successfully', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fetchOk({
          content: [{ type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://example.com' } }],
          stop_reason: 'tool_use',
        }),
      )
      .mockResolvedValueOnce(fetchOk({ content: [{ type: 'text', text: 'opened it for you' }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(executeNavigate).mockResolvedValue({ ok: true, resultText: 'opened example.com' });

    const reply = await byokChatAsk('open example.com', [], 7);
    expect(reply.type).toBe('chatAnswer');
    if (reply.type === 'chatAnswer') {
      expect(reply.answer).toContain('opened it for you');
      expect(reply.answer).toContain('(opened example.com)');
    }
    expect(executeNavigate).toHaveBeenCalledWith({ url: 'https://example.com' }, 7);
  });

  it('retrieves matching local-brain nodes into the prompt and cites them as sources', async () => {
    const { emptyBrain, placeNode } = await import('@nff-brain/core/types');
    const brain = emptyBrain();
    brain.nodes.push({
      id: 'esp32-cors-preflight',
      title: 'esp32 cors preflight',
      category: 'strategy',
      content: 'Answer the CORS preflight before auth or extension calls fail opaquely.',
      ...placeNode('strategy'),
      origin: 'clip',
      sourceUrl: 'https://example.com/a',
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    });
    const storage = await import('../src/storage.js');
    vi.mocked(storage.getBrain).mockResolvedValue(brain);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fetchOk({ content: [{ type: 'text', text: 'from your notes: answer it first' }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', fetchMock);

    const reply = await byokChatAsk('why do my cors preflight calls fail?', [], 1);
    expect(reply.type).toBe('chatAnswer');
    if (reply.type === 'chatAnswer') {
      expect(reply.sources).toEqual([{ id: 'esp32-cors-preflight', title: 'esp32 cors preflight' }]);
    }
    const sentPrompt = JSON.parse(fetchMock.mock.calls[0]![1].body).messages[0].content as string;
    expect(sentPrompt).toContain('Answer the CORS preflight');
  });

  it('maps a provider failure to its short user-showable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 429, text: async () => '{}' }));
    const reply = await byokChatAsk('hi', [], 1);
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toBe('provider rate limit hit');
  });
});
