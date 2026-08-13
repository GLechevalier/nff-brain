// The action run's write path. Like brainStore.ts, chrome.storage has no
// transactions and two awaited mutations in one worker lifetime can interleave
// between read and write — and here two DO race: the running loop appends
// transcript/counters while the panel port answers a grant prompt. So every
// nb.actRun mutation is serialized on one promise chain.
//
// The chain is the THIRD documented module-level variable in this codebase
// (after connection.ts's inFlightProbe and brainStore.ts's mutateChain), and it
// is harmless to lose for the same reason: it only matters within one worker
// lifetime, which is exactly a module variable's lifespan. Worker death means no
// mutation is in flight. bundlePurity.test.ts pins this file to this one var.

import { ACT_TRANSCRIPT_MAX } from './schema.js';
import type { ActRunState, ActTranscriptEntry } from './schema.js';
import { getActRun, setActRun } from './storage.js';

let mutateChain: Promise<unknown> = Promise.resolve(); // harmless to lose — see header

function runExclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = mutateChain.then(job, job);
  mutateChain = next.catch(() => undefined);
  return next;
}

/** load → mutate → save, serialized. Returns the run the mutation left in place (or null if cleared/absent). */
export function mutateActRun(fn: (run: ActRunState) => void): Promise<ActRunState | null> {
  return runExclusive(async () => {
    const run = await getActRun();
    if (!run) return null;
    fn(run);
    run.updatedAt = new Date().toISOString();
    if (run.transcript.length > ACT_TRANSCRIPT_MAX) {
      run.transcript = run.transcript.slice(-ACT_TRANSCRIPT_MAX);
    }
    await setActRun(run);
    return run;
  });
}

export function startActRun(run: ActRunState): Promise<void> {
  return runExclusive(() => setActRun(run));
}

export function clearActRun(): Promise<void> {
  return runExclusive(() => setActRun(null));
}

export function appendTranscript(entry: Omit<ActTranscriptEntry, 'at'>): Promise<ActRunState | null> {
  return mutateActRun((run) => {
    run.transcript.push({ at: new Date().toISOString(), ...entry });
  });
}
