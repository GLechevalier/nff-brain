// Per-session model state: what tier each Claude session is currently on, and
// how many consecutive prompts have argued for a cheaper one.
//
// It exists because model-request.json is a single shared file. Two sessions in
// one workspace used to interfere through it: session A pins a tier, session B
// starts wanting the same tier, sees the request already saying so, skips its
// own write — and never gets /model typed at all. Keying the decision by
// session_id here keeps the request file as the one thing the extension
// watches while the DECISION becomes per-session.
//
// It also carries the hysteresis streak (see applyHysteresis in novelty.ts),
// which has to survive between prompts.
//
// KNOWN LIMITATION — this fixes the state half only. The extension still finds
// its target terminal by name (findClaudeTerminal in the VS Code extension), so
// with two Claude terminals open in one workspace a request can still be typed
// into the wrong one. There is no session→terminal mapping available to fix it.
//
// Concurrency stance, like activityStore: no lock. The temp+rename write is
// atomic so no reader ever sees a torn file, but two hooks racing can lose one
// update. Each session owns a distinct key, so the worst case is a dropped
// streak counter — a tier switch one prompt early or late in a subsystem that
// is advisory anyway. If that ever bites, split to one file per session.

import * as fs from 'node:fs';
import { brainLogPath } from './paths.js';
import { writeFileAtomic } from './store.js';

export const MODEL_STATE_FILE = 'model-state.json';

const PRUNE_DEFAULTS = {
  maxAgeMs: 24 * 60 * 60 * 1000, // a session that has been quiet for a day is over
  maxSessions: 20,
};

export interface SessionModelState {
  model: string;
  novelty: number;
  belowStreak: number; // consecutive prompts below the downgrade band
  ts: string; // ISO — last time this session was scored
}

export interface ModelState {
  version: 1;
  sessions: Record<string, SessionModelState>; // keyed by the hook's session_id
}

export function modelStatePath(brainPath: string): string {
  return brainLogPath(brainPath, MODEL_STATE_FILE);
}

export function emptyModelState(): ModelState {
  return { version: 1, sessions: {} };
}

/** Absent, unreadable or malformed all read as "no history" — never throws. */
export function readModelState(brainPath: string): ModelState {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelStatePath(brainPath), 'utf8')) as ModelState;
    if (typeof parsed !== 'object' || parsed === null) return emptyModelState();
    const sessions = parsed.sessions;
    if (typeof sessions !== 'object' || sessions === null) return emptyModelState();
    // Drop entries that lost their shape rather than failing the whole file.
    const clean: Record<string, SessionModelState> = {};
    for (const [id, s] of Object.entries(sessions)) {
      if (s && typeof s.model === 'string' && typeof s.ts === 'string') {
        clean[id] = {
          model: s.model,
          novelty: typeof s.novelty === 'number' ? s.novelty : 0,
          belowStreak: typeof s.belowStreak === 'number' ? s.belowStreak : 0,
          ts: s.ts,
        };
      }
    }
    return { version: 1, sessions: clean };
  } catch {
    return emptyModelState();
  }
}

/** Atomic write — shares store.ts's Windows EPERM/EBUSY rename retry. */
export function writeModelState(brainPath: string, state: ModelState): void {
  writeFileAtomic(modelStatePath(brainPath), JSON.stringify(state, null, 2) + '\n');
}

/**
 * Drop dead sessions: too old first, then the oldest beyond the cap. Pure — the
 * caller decides when to persist the result (SessionStart is the natural once-
 * per-session moment).
 */
export function pruneSessions(
  state: ModelState,
  opts: { maxAgeMs?: number; maxSessions?: number; now?: number } = {},
): ModelState {
  const maxAgeMs = opts.maxAgeMs ?? PRUNE_DEFAULTS.maxAgeMs;
  const maxSessions = opts.maxSessions ?? PRUNE_DEFAULTS.maxSessions;
  const now = opts.now ?? Date.now();

  const entries = Object.entries(state.sessions ?? {}).filter(([, s]) => {
    const age = now - Date.parse(s.ts);
    return Number.isFinite(age) && age <= maxAgeMs; // an unparseable ts is dead weight
  });
  // Newest first, then keep the cap.
  entries.sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts));
  return { version: 1, sessions: Object.fromEntries(entries.slice(0, maxSessions)) };
}
