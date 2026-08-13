import { beforeEach, describe, expect, it } from 'vitest';

// Minimal chrome.storage.local stub — same shape standalone.test.ts uses,
// just enough for storage.ts's raw<T>() get/set round trip.
function stubChrome(initial: Record<string, unknown> = {}): void {
  const store: Record<string, unknown> = { ...initial };
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

describe('agent action allowlist storage', () => {
  beforeEach(() => stubChrome());

  it('defaults to an empty byId map when nothing is stored yet', async () => {
    const { getAgentActionAllow } = await import('../src/storage.js');
    expect(await getAgentActionAllow()).toEqual({ byId: {} });
  });

  it('round-trips a granted "never ask again" entry', async () => {
    const { getAgentActionAllow, setAgentActionAllow } = await import('../src/storage.js');
    await setAgentActionAllow({ byId: { linkedin: { allowed: true, changedAt: '2026-01-01T00:00:00.000Z' } } });
    expect(await getAgentActionAllow()).toEqual({
      byId: { linkedin: { allowed: true, changedAt: '2026-01-01T00:00:00.000Z' } },
    });
  });

  it('a corrupt stored value degrades to the empty default rather than throwing', async () => {
    stubChrome({ 'nb.agentActionAllow': 'not even an object' });
    const { getAgentActionAllow } = await import('../src/storage.js');
    expect(await getAgentActionAllow()).toEqual({ byId: {} });
  });
});
