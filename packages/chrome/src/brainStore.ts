// The standalone brain's write path. chrome.storage.local has no transactions,
// and two awaited mutations in one worker lifetime CAN interleave between their
// read and their write — so every mutation is serialized on one promise chain.
//
// The chain is the SECOND documented module-level variable in this codebase
// (after connection.ts's inFlightProbe), and it is harmless to lose for the
// same reason: the chain only matters within one worker lifetime, which is
// exactly the span a module variable survives. Worker death means no mutation
// is in flight, so a fresh chain on the next cold start is correct, not a bug.
// bundlePurity.test.ts pins this file to exactly this one variable.

import { emptyBrain } from '@nff-brain/core/types';
import type { BrainFile } from '@nff-brain/core/types';
import { getBrain, setBrain } from './storage.js';

let mutateChain: Promise<unknown> = Promise.resolve(); // harmless to lose — see header

/**
 * Serialize any read-modify-write against the standalone keys. The drain's
 * commitDrain() also runs through here so a concurrent retract can never
 * interleave between the drain's read and its multi-key write.
 */
export function runExclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = mutateChain.then(job, job);
  // Keep the chain alive past failures; the caller still sees the rejection.
  mutateChain = next.catch(() => undefined);
  return next;
}

export function readLocalBrain(): Promise<BrainFile> {
  return getBrain().then((b) => b ?? emptyBrain());
}

/** load → mutate → save, serialized. The browser mutateBrain(). */
export function mutateLocalBrain<T>(fn: (brain: BrainFile) => T): Promise<T> {
  return runExclusive(async () => {
    const brain = await readLocalBrain();
    const result = fn(brain);
    brain.updatedAt = new Date().toISOString();
    await setBrain(brain);
    return result;
  });
}
