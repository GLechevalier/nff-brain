import { describe, expect, it } from 'vitest';
import { emptyBrain, placeNode } from '@nff-brain/core/types';
import type { BrainFile, BrainNode } from '@nff-brain/core/types';

// First suite in this package to stub chrome.* (storage.local only, the
// minimum handleStandaloneMessage touches): the standalone responses must
// satisfy the SAME protocol type guards the panel applies to server replies,
// which is exactly what makes both modes render with zero panel changes.

import { isGraphResponse, isLayoutResponse, isNodesResponse, isSearchResponse } from '../src/protocol.js';

function fixtureBrain(): BrainFile {
  const brain = emptyBrain();
  const mk = (id: string, content: string): BrainNode => ({
    id,
    title: id.replace(/-/g, ' '),
    category: 'strategy',
    content,
    ...placeNode('strategy'),
    origin: 'clip',
    sourceUrl: 'https://example.com/a',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
  });
  brain.nodes.push(
    mk('esp32-cors-preflight', 'Answer the CORS preflight before auth or extension calls fail opaquely.'),
    mk('vitest-fake-timers', 'Use vi.useFakeTimers around interval-driven code.'),
  );
  brain.edges.push({ from: 'esp32-cors-preflight', to: 'vitest-fake-timers', strength: 0.4 });
  return brain;
}

// A minimal chrome.storage.local stub so the storage.ts monopoly module works
// in node — only what getBrain/getActivity need.
function stubChrome(brain: BrainFile): void {
  const store: Record<string, unknown> = { 'nb.brain': brain, 'nb.activity': [] };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Promise.resolve(Object.fromEntries(keys.map((k) => [k, store[k]])));
        },
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
      },
    },
  };
}

describe('standalone message surfaces', () => {
  it('getNodes/searchBrain/getGraph responses satisfy the panel type guards', async () => {
    stubChrome(fixtureBrain());
    const { handleStandaloneMessage } = await import('../src/standalone.js');

    const nodes = await handleStandaloneMessage({ type: 'getNodes' });
    expect(nodes && nodes !== 'handled' && nodes.type).toBe('nodes');
    if (nodes && nodes !== 'handled' && nodes.type === 'nodes') {
      expect(isNodesResponse(nodes.data)).toBe(true);
      expect(nodes.data.merged.nodes).toBe(2);
      expect(nodes.data.workspace.name).toBe('standalone');
    }

    const search = await handleStandaloneMessage({ type: 'searchBrain', q: 'cors preflight auth' });
    expect(search && search !== 'handled' && search.type).toBe('search');
    if (search && search !== 'handled' && search.type === 'search') {
      expect(isSearchResponse(search.data)).toBe(true);
      expect(search.data.hits[0]!.id).toBe('esp32-cors-preflight');
      expect(search.data.hits[0]!.related[0]!.id).toBe('vitest-fake-timers');
    }

    const graph = await handleStandaloneMessage({ type: 'getGraph' });
    expect(graph && graph !== 'handled' && graph.type).toBe('graph');
    if (graph && graph !== 'handled' && graph.type === 'graph') {
      expect(isGraphResponse({ ok: true, nodes: graph.nodes, edges: graph.edges })).toBe(true);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
    }
  });

  it('moveGraphNode persists the drop and getGraph reflects it afterwards', async () => {
    stubChrome(fixtureBrain());
    const { handleStandaloneMessage } = await import('../src/standalone.js');

    const moved = await handleStandaloneMessage({ type: 'moveGraphNode', id: 'esp32-cors-preflight', x: 42, y: -7 });
    expect(moved && moved !== 'handled' && moved.type).toBe('layout');
    if (moved && moved !== 'handled' && moved.type === 'layout') {
      expect(isLayoutResponse({ ok: true, moved: moved.moved })).toBe(true);
      expect(moved.moved).toBe(true);
    }

    const graph = await handleStandaloneMessage({ type: 'getGraph' });
    if (graph && graph !== 'handled' && graph.type === 'graph') {
      const node = graph.nodes.find((n) => n.id === 'esp32-cors-preflight');
      expect(node?.x).toBe(42);
      expect(node?.y).toBe(-7);
    }
  });

  it('moveGraphNode on an unknown id is a no-op reply, not a throw', async () => {
    stubChrome(fixtureBrain());
    const { handleStandaloneMessage } = await import('../src/standalone.js');
    const moved = await handleStandaloneMessage({ type: 'moveGraphNode', id: 'no-such-node', x: 1, y: 2 });
    expect(moved && moved !== 'handled' && moved.type).toBe('layout');
    if (moved && moved !== 'handled' && moved.type === 'layout') expect(moved.moved).toBe(false);
  });

  it('chatAsk without a configured key returns a pointer at Settings, never a throw', async () => {
    stubChrome(fixtureBrain());
    const { handleStandaloneMessage } = await import('../src/standalone.js');
    const reply = await handleStandaloneMessage({ type: 'chatAsk', message: 'hi', history: [], tabId: 1 });
    expect(reply && reply !== 'handled' && reply.type).toBe('error');
    if (reply && reply !== 'handled' && reply.type === 'error') {
      expect(reply.message).toContain('API key');
    }
  });

  it('messages with no standalone meaning fall through as null', async () => {
    stubChrome(fixtureBrain());
    const { handleStandaloneMessage } = await import('../src/standalone.js');
    expect(await handleStandaloneMessage({ type: 'getMcpServers' })).toBeNull();
    expect(await handleStandaloneMessage({ type: 'getAgentStatus' })).toBeNull();
    expect(await handleStandaloneMessage({ type: 'probeNow' })).toBeNull();
  });
});
