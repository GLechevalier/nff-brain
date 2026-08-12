import { describe, expect, it } from 'vitest';
import {
  PROBE_INTERVALS_MS,
  applyProbe,
  derivePhase,
  dueForProbe,
  nextIntervalMs,
  relativeAge,
  stalenessMs,
} from '../src/health.js';
import { DEFAULT_HEALTH } from '../src/schema.js';
import type { Health } from '../src/schema.js';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

function health(over: Partial<Health> = {}): Health {
  return { ...DEFAULT_HEALTH, ...over };
}

describe('backoff ladder', () => {
  it('walks the ladder and clamps at the tail', () => {
    expect(nextIntervalMs(0)).toBe(60_000);
    expect(nextIntervalMs(1)).toBe(120_000);
    expect(nextIntervalMs(4)).toBe(900_000);
    expect(nextIntervalMs(99)).toBe(PROBE_INTERVALS_MS[PROBE_INTERVALS_MS.length - 1]);
  });

  it('never goes backwards', () => {
    for (let i = 1; i < 10; i++) expect(nextIntervalMs(i)).toBeGreaterThanOrEqual(nextIntervalMs(i - 1));
  });

  it('allows three intervals of staleness', () => {
    expect(stalenessMs(0)).toBe(180_000);
  });
});

describe('derivePhase', () => {
  it('is unpaired without a pairing, whatever the health says', () => {
    expect(derivePhase(health({ phase: 'connected', lastOkAt: new Date(NOW).toISOString() }), false, NOW)).toBe('unpaired');
  });

  it('is connected on a fresh success', () => {
    expect(derivePhase(health({ lastOkAt: new Date(NOW - 10_000).toISOString() }), true, NOW)).toBe('connected');
  });

  it('degrades to disconnected once the last success goes stale', () => {
    // A worker that stops being woken must not leave the popup showing
    // "Connected · 142 nodes" from twenty minutes ago.
    expect(derivePhase(health({ lastOkAt: new Date(NOW - 200_000).toISOString() }), true, NOW)).toBe('disconnected');
  });

  it('is disconnected when nothing has ever succeeded', () => {
    expect(derivePhase(health(), true, NOW)).toBe('disconnected');
  });

  it('stays rejected and never recovers on its own', () => {
    const h = health({ phase: 'rejected', lastOkAt: new Date(NOW).toISOString() });
    expect(derivePhase(h, true, NOW)).toBe('rejected');
    expect(derivePhase(h, true, NOW + 86_400_000)).toBe('rejected');
  });
});

describe('applyProbe', () => {
  it('records a success and resets the failure count', () => {
    const next = applyProbe(health({ consecutiveFailures: 3 }), {
      ok: true,
      status: {
        projectNodes: 42,
        globalNodes: 7,
        mergedNodes: 47,
        workspaceRoot: '/ws',
        serverVersion: '0.1.0',
        queuePending: 2,
      },
    }, NOW);
    expect(next.phase).toBe('connected');
    expect(next.consecutiveFailures).toBe(0);
    expect(next.projectNodes).toBe(42);
    expect(next.mergedNodes).toBe(47);
    expect(next.nextProbeAtMs).toBe(NOW + 60_000);
    expect(next.lastError).toBeNull();
  });

  it('backs off further on each consecutive failure', () => {
    let h = health();
    h = applyProbe(h, { ok: false, error: 'ECONNREFUSED' }, NOW);
    expect(h.phase).toBe('disconnected');
    expect(h.nextProbeAtMs).toBe(NOW + 120_000);
    h = applyProbe(h, { ok: false }, NOW);
    expect(h.nextProbeAtMs).toBe(NOW + 300_000);
  });

  it('keeps the last known counts through a failure so the popup can be honest', () => {
    const ok = applyProbe(health(), {
      ok: true,
      status: { projectNodes: 42, globalNodes: 7, mergedNodes: 47, workspaceRoot: '/ws', serverVersion: '1', queuePending: 0 },
    }, NOW);
    const failed = applyProbe(ok, { ok: false }, NOW + 1000);
    expect(failed.projectNodes).toBe(42);
    expect(failed.lastOkAt).toBe(ok.lastOkAt);
  });

  it('stops probing entirely on a rejection', () => {
    const next = applyProbe(health(), { ok: false, rejected: true, error: '401' }, NOW);
    expect(next.phase).toBe('rejected');
    expect(dueForProbe(next, NOW + 86_400_000 * 365)).toBe(false);
  });

  it('keeps nextProbeAtMs JSON-round-trippable', () => {
    // Infinity would serialize to null through chrome.storage and silently
    // become "probe immediately, forever".
    const next = applyProbe(health(), { ok: false, rejected: true }, NOW);
    expect(JSON.parse(JSON.stringify(next)).nextProbeAtMs).toBe(next.nextProbeAtMs);
    expect(Number.isFinite(next.nextProbeAtMs)).toBe(true);
  });
});

describe('dueForProbe', () => {
  it('gates on the stored schedule, not on the alarm', () => {
    expect(dueForProbe(health({ nextProbeAtMs: NOW + 1 }), NOW)).toBe(false);
    expect(dueForProbe(health({ nextProbeAtMs: NOW }), NOW)).toBe(true);
  });
});

describe('relativeAge', () => {
  it.each([
    [10_000, 'just now'],
    [4 * 60_000, '4 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [2 * 86_400_000, '2 d ago'],
  ])('renders %i ms as %s', (ms, expected) => {
    expect(relativeAge(new Date(NOW - ms).toISOString(), NOW)).toBe(expected);
  });

  it('is null for a missing or unparseable timestamp', () => {
    expect(relativeAge(null, NOW)).toBeNull();
    expect(relativeAge('nonsense', NOW)).toBeNull();
  });
});
