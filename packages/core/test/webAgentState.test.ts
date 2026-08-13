import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveActiveRun,
  computeNextAllowedAtMs,
  newRunId,
  readWebAgentState,
  shouldGrantAction,
  updateActiveRun,
  writeWebAgentState,
} from '../src/index.js';
import type { WebAgentRun, WebAgentState } from '../src/index.js';

function run(over: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: 'run_1',
    phase: 'running',
    clientId: 'cl_1',
    goal: 'find robotics engineers',
    autoApprove: false,
    plan: null,
    listTarget: null,
    cursor: 0,
    pendingConnects: [],
    pendingConnectsStepId: null,
    actionsTaken: 0,
    maxActions: 5,
    nextAllowedAtMs: 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    history: [],
    ...over,
  };
}

describe('webAgentState store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-webagent-'));
    file = path.join(dir, 'web-agent.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('absent, corrupt or malformed all read as "no active run" — never throws', () => {
    expect(readWebAgentState(file)).toEqual({ version: 1, active: null, recent: [] });
    fs.writeFileSync(file, 'not json');
    expect(readWebAgentState(file)).toEqual({ version: 1, active: null, recent: [] });
    fs.writeFileSync(file, JSON.stringify({ active: { id: 'x' } })); // missing required fields
    expect(readWebAgentState(file).active).toBeNull();
  });

  it('round-trips a real run through write/read', () => {
    const state: WebAgentState = { version: 1, active: run(), recent: [] };
    writeWebAgentState(state, file);
    expect(readWebAgentState(file)).toEqual(state);
  });

  it('newRunId mints a distinct id per call', () => {
    expect(newRunId(1000)).not.toBe(newRunId(1000));
  });
});

describe('updateActiveRun', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-webagent-'));
    file = path.join(dir, 'web-agent.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops a stale write when the active run id no longer matches', () => {
    writeWebAgentState({ version: 1, active: run({ id: 'run_1' }), recent: [] }, file);
    const result = updateActiveRun('run_stale', (r) => ({ ...r, actionsTaken: 99 }), file);
    expect(result).toBeNull();
    expect(readWebAgentState(file).active!.actionsTaken).toBe(0);
  });

  it('auto-archives into recent the moment the mutation reaches a terminal phase', () => {
    writeWebAgentState({ version: 1, active: run({ id: 'run_1' }), recent: [] }, file);
    updateActiveRun('run_1', (r) => ({ ...r, phase: 'done' }), file);
    const state = readWebAgentState(file);
    expect(state.active).toBeNull();
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0].phase).toBe('done');
  });
});

describe('archiveActiveRun', () => {
  it('is a no-op when there is no active run', () => {
    const state: WebAgentState = { version: 1, active: null, recent: [] };
    expect(archiveActiveRun(state)).toBe(state);
  });

  it('moves the active run to the front of recent', () => {
    const state: WebAgentState = { version: 1, active: run({ id: 'run_2' }), recent: [run({ id: 'run_1' })] };
    const next = archiveActiveRun(state);
    expect(next.active).toBeNull();
    expect(next.recent.map((r) => r.id)).toEqual(['run_2', 'run_1']);
  });
});

describe('shouldGrantAction', () => {
  it('refuses when the run is not running', () => {
    expect(shouldGrantAction(run({ phase: 'awaiting_approval' }), 0)).toBe(false);
  });

  it('refuses once the cap is reached', () => {
    expect(shouldGrantAction(run({ actionsTaken: 5, maxActions: 5 }), 0)).toBe(false);
  });

  it('refuses before the pacing gate', () => {
    expect(shouldGrantAction(run({ nextAllowedAtMs: 1000 }), 500)).toBe(false);
  });

  it('grants when running, under cap, and past the pacing gate', () => {
    expect(shouldGrantAction(run({ actionsTaken: 1, maxActions: 5, nextAllowedAtMs: 1000 }), 1000)).toBe(true);
  });
});

describe('computeNextAllowedAtMs', () => {
  it('draws 1-4 minutes uniformly after now, with an injectable RNG for determinism', () => {
    expect(computeNextAllowedAtMs(0, () => 0)).toBe(60_000);
    expect(computeNextAllowedAtMs(0, () => 1)).toBe(240_000);
  });

  it('the floor is exactly 60s — chrome.alarms cannot schedule faster than that in a packaged extension', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(computeNextAllowedAtMs(1000, () => r)).toBeGreaterThanOrEqual(1000 + 60_000);
    }
  });
});
