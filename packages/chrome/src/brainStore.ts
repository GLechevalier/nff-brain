// The local brain's write path. chrome.storage.local has no transactions,
// and two awaited mutations in one worker lifetime CAN interleave between their
// read and their write — so every mutation is serialized on one promise chain.
//
// The chain is a documented module-level variable exception (like
// connection.ts's inFlightProbe), and it is harmless to lose for the same
// reason: the chain only matters within one worker lifetime, which is exactly
// the span a module variable survives. Worker death means no mutation is in
// flight, so a fresh chain on the next cold start is correct, not a bug.
// bundlePurity.test.ts pins this file to exactly this one variable.

import { emptyBrain } from '@nff-brain/core/types';
import type { BrainEdge, BrainFile, BrainNode } from '@nff-brain/core/types';
import { getBrain, getBrainSync, setBrain } from './storage.js';

/** Hard ceiling for the local brain after a server import — keeps nb.brain
 *  ≈ well under a MB against the 10 MB storage.local quota. */
export const IMPORT_NODE_CAP = 500;

let mutateChain: Promise<unknown> = Promise.resolve(); // harmless to lose — see header

/**
 * Serialize any read-modify-write against the local-brain keys. The drain's
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
    // Auto company sync: every local mutation re-arms a one-shot debounce
    // alarm (MV3 — a setTimeout dies with the worker); sw.ts's onAlarm runs
    // the push, which re-checks the toggles itself. ponytail: paired-mode
    // server-side brain changes don't trip this — they sync on the next
    // manual push or local change.
    const sync = await getBrainSync();
    if (sync?.enabled && sync.auto && sync.token) chrome.alarms.create('brainSync', { delayInMinutes: 1 });
    return result;
  });
}

/**
 * One-way merge of a server export into the local brain: unknown nodes are
 * added, known ids are replaced only when the imported copy is NEWER
 * (lastUpdated), nothing local is ever deleted by the merge itself — only
 * the newest-first cap trims, and edges follow their surviving endpoints.
 */
export function mergeImportedBrain(nodes: BrainNode[], edges: BrainEdge[]): Promise<{ imported: number; total: number }> {
  return mutateLocalBrain((brain) => {
    let imported = 0;
    const byId = new Map(brain.nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const existing = byId.get(n.id);
      if (!existing) {
        brain.nodes.push(n);
        byId.set(n.id, n);
        imported++;
      } else if ((n.lastUpdated ?? '') > (existing.lastUpdated ?? '')) {
        // The server export knows nothing about the LOCAL company-sync flags —
        // a newer server copy must not clobber a private/shared choice made here.
        const keepPrivate = existing.private;
        const keepShared = existing.shared;
        Object.assign(existing, n);
        if (n.private === undefined) existing.private = keepPrivate;
        if (n.shared === undefined) existing.shared = keepShared;
        imported++;
      }
    }
    if (brain.nodes.length > IMPORT_NODE_CAP) {
      brain.nodes.sort((a, b) => ((a.lastUpdated ?? '') < (b.lastUpdated ?? '') ? 1 : -1));
      brain.nodes = brain.nodes.slice(0, IMPORT_NODE_CAP);
    }
    const nodeIds = new Set(brain.nodes.map((n) => n.id));
    brain.edges = brain.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    const have = new Set(brain.edges.map((e) => `${e.from}→${e.to}`));
    for (const e of edges) {
      const key = `${e.from}→${e.to}`;
      if (nodeIds.has(e.from) && nodeIds.has(e.to) && !have.has(key)) {
        brain.edges.push({ from: e.from, to: e.to, strength: e.strength });
        have.add(key);
      }
    }
    return { imported, total: brain.nodes.length };
  });
}
