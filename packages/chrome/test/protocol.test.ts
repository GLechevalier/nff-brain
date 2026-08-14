import { describe, expect, it } from 'vitest';
import {
  isAgentStatusResponse,
  isClipsMapResponse,
  isGraphResponse,
  isNodesResponse,
  isRetractResponse,
  isSearchResponse,
} from '../src/protocol.js';

// NEVER TRUST THE WIRE: a malformed body must read as a protocol error, never
// as "zero nodes" / "nothing to retract" — those are real, alarming states and
// must not be manufacturable by a truncated response.

describe('panel + feedback-loop wire guards', () => {
  it('isNodesResponse rejects everything but the real shape', () => {
    expect(isNodesResponse({})).toBe(false);
    expect(isNodesResponse({ ok: true })).toBe(false);
    expect(isNodesResponse({ ok: true, merged: { nodes: 1 }, recent: [{ id: 1 }] })).toBe(false);
    expect(
      isNodesResponse({
        ok: true,
        updatedAt: null,
        merged: { nodes: 4, edges: 2 },
        workspace: { name: 'ws', nodes: 3, edges: 2 },
        global: { nodes: 1, edges: 0 },
        recent: [{ id: 'a', title: 'A', category: 'strategy', origin: 'agent', source: 'project', lastUpdated: 'x', excerpt: '' }],
      }),
    ).toBe(true);
  });

  it('isSearchResponse rejects truncated hits', () => {
    expect(isSearchResponse({ ok: true, q: 'x', count: 1, hits: [{}] })).toBe(false);
    expect(isSearchResponse({ ok: true, q: 'x', count: 0, hits: [] })).toBe(true);
  });

  it('isClipsMapResponse demands string nodeIds throughout', () => {
    expect(isClipsMapResponse({ ok: true, map: [{ clipId: 'c', nodeIds: [1] }] })).toBe(false);
    expect(isClipsMapResponse({ ok: true, map: [{ clipId: 'c', nodeIds: ['n'] }] })).toBe(true);
    expect(isClipsMapResponse({ ok: true, map: [] })).toBe(true);
  });

  it('isRetractResponse demands a removed array', () => {
    expect(isRetractResponse({ ok: true })).toBe(false);
    expect(isRetractResponse({ ok: true, removed: [] })).toBe(true);
  });

  it('isAgentStatusResponse tolerates a missing lastRun (older server) but never a malformed one', () => {
    const run = {
      id: 'run_1',
      phase: 'error',
      goal: 'g',
      cursor: 0,
      actionsTaken: 0,
      maxActions: 5,
      history: [],
    };
    expect(isAgentStatusResponse({ ok: true, run: null })).toBe(true);
    expect(isAgentStatusResponse({ ok: true, run: null, lastRun: null })).toBe(true);
    expect(isAgentStatusResponse({ ok: true, run: null, lastRun: run })).toBe(true);
    expect(isAgentStatusResponse({ ok: true, run, lastRun: run })).toBe(true);
    expect(isAgentStatusResponse({ ok: true, run: null, lastRun: 'garbage' })).toBe(false);
    expect(isAgentStatusResponse({ ok: true, run: null, lastRun: { id: 'r', phase: 'not-a-phase' } })).toBe(false);
  });

  it('isGraphResponse demands numeric geometry on every node', () => {
    expect(isGraphResponse({ ok: true })).toBe(false);
    expect(isGraphResponse({ ok: true, nodes: [{ id: 'a' }], edges: [] })).toBe(false);
    expect(isGraphResponse({ ok: true, nodes: [{ id: 'a', x: 0, y: 0 }], edges: [{ from: 'a', to: 'b' }] })).toBe(true);
    expect(isGraphResponse({ ok: true, nodes: [], edges: [{ from: 'a' }] })).toBe(false);
    expect(isGraphResponse({ ok: true, nodes: [], edges: [] })).toBe(true);
  });
});
