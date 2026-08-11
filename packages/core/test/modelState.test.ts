import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyModelState,
  modelStatePath,
  pruneSessions,
  readModelState,
  writeModelState,
  type ModelState,
  type SessionModelState,
} from '../src/index.js';

const session = (over: Partial<SessionModelState> = {}): SessionModelState => ({
  model: 'opus',
  novelty: 0.5,
  belowStreak: 0,
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('modelState store', () => {
  let dir: string;
  let brainPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-state-'));
    brainPath = path.join(dir, '.nff-brain', 'brain.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lands beside brain.json', () => {
    expect(modelStatePath(brainPath)).toBe(path.join(dir, '.nff-brain', 'model-state.json'));
  });

  it('round-trips through write/read, creating the directory', () => {
    const state: ModelState = { version: 1, sessions: { a: session({ belowStreak: 2 }) } };
    writeModelState(brainPath, state);
    expect(readModelState(brainPath)).toEqual(state);
  });

  it('reads a missing file as empty history', () => {
    expect(readModelState(brainPath)).toEqual(emptyModelState());
  });

  it('reads malformed content as empty history rather than throwing', () => {
    fs.mkdirSync(path.dirname(brainPath), { recursive: true });
    for (const junk of ['not json at all', '[]', 'null', '{"version":1}', '{"version":1,"sessions":3}']) {
      fs.writeFileSync(modelStatePath(brainPath), junk);
      expect(readModelState(brainPath), junk).toEqual(emptyModelState());
    }
  });

  it('drops individual malformed sessions but keeps the sound ones', () => {
    fs.mkdirSync(path.dirname(brainPath), { recursive: true });
    fs.writeFileSync(
      modelStatePath(brainPath),
      JSON.stringify({ version: 1, sessions: { good: session(), bad: { novelty: 0.2 } } }),
    );
    const read = readModelState(brainPath);
    expect(Object.keys(read.sessions)).toEqual(['good']);
  });

  it('backfills missing numeric fields', () => {
    fs.mkdirSync(path.dirname(brainPath), { recursive: true });
    fs.writeFileSync(
      modelStatePath(brainPath),
      JSON.stringify({ version: 1, sessions: { a: { model: 'opus', ts: '2026-01-01T00:00:00.000Z' } } }),
    );
    expect(readModelState(brainPath).sessions.a).toEqual(session({ novelty: 0 }));
  });

  it('overwrites in place and leaves no temp file behind', () => {
    writeModelState(brainPath, { version: 1, sessions: { a: session({ model: 'sonnet' }) } });
    writeModelState(brainPath, { version: 1, sessions: { a: session({ model: 'fable' }) } });
    expect(readModelState(brainPath).sessions.a.model).toBe('fable');
    expect(fs.readdirSync(path.dirname(brainPath))).toEqual(['model-state.json']);
  });
});

describe('pruneSessions', () => {
  const now = Date.parse('2026-01-02T00:00:00.000Z');
  const at = (iso: string) => session({ ts: iso });

  it('drops sessions past the age limit', () => {
    const state: ModelState = {
      version: 1,
      sessions: {
        fresh: at('2026-01-01T23:00:00.000Z'), // 1h old
        stale: at('2025-12-30T00:00:00.000Z'), // 3d old
      },
    };
    expect(Object.keys(pruneSessions(state, { now }).sessions)).toEqual(['fresh']);
  });

  it('drops sessions with an unparseable timestamp', () => {
    const state: ModelState = { version: 1, sessions: { bad: at('whenever'), ok: at('2026-01-01T23:00:00.000Z') } };
    expect(Object.keys(pruneSessions(state, { now }).sessions)).toEqual(['ok']);
  });

  it('caps at the newest N', () => {
    const sessions: Record<string, SessionModelState> = {};
    for (let i = 0; i < 5; i++) {
      sessions[`s${i}`] = at(`2026-01-01T0${i}:00:00.000Z`);
    }
    const kept = pruneSessions({ version: 1, sessions }, { now, maxSessions: 2 }).sessions;
    expect(Object.keys(kept).sort()).toEqual(['s3', 's4']); // newest two
  });

  it('is pure — the input is untouched', () => {
    const state: ModelState = { version: 1, sessions: { stale: at('2020-01-01T00:00:00.000Z') } };
    pruneSessions(state, { now });
    expect(Object.keys(state.sessions)).toEqual(['stale']);
  });

  it('tolerates an empty state', () => {
    expect(pruneSessions(emptyModelState(), { now })).toEqual(emptyModelState());
  });
});
