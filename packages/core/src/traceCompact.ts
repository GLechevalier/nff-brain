// Pre-distillation pass over a raw event trace: drop noise, collapse runs, and —
// the important part — detect a REPEATED sub-sequence (the user demonstrating a
// loop, e.g. open-profile → connect → back, three times) and tag each event
// with the repeat group it belongs to. The distiller renders those tags as
// explicit prompt hints so a loop becomes ONE loop step with a count, never N
// copies. Pure, node-free (browser-safe).

import type { TraceEvent } from './trace.js';

/** A stable-ish signature for an event, for equality when finding repeats. */
export function eventSignature(e: TraceEvent): string {
  const tgt = e.target;
  const who = tgt ? `${tgt.role ?? tgt.tag}:${(tgt.name ?? '').toLowerCase().slice(0, 24)}` : '';
  // The typed VALUE deliberately does not enter the signature — the same loop
  // body typing a different name each iteration must still match.
  return `${e.kind}|${who}`;
}

/** Drop obvious noise: a scroll immediately followed by another scroll same dir; a duplicate click within 200ms. */
function dropNoise(events: TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev) {
      if (e.kind === 'scroll' && prev.kind === 'scroll' && e.dir === prev.dir) continue;
      if (
        e.kind === 'click' &&
        prev.kind === 'click' &&
        eventSignature(e) === eventSignature(prev) &&
        e.t - prev.t < 200
      ) {
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

export interface CompactResult {
  events: TraceEvent[];
  /** Number of distinct repeat groups found (0 = no loop detected). */
  repeatGroups: number;
  /** For the dominant group: the period (body length) and repetition count. */
  dominant: { period: number; reps: number; start: number } | null;
}

/**
 * Find the dominant repeated contiguous block. Returns the run that covers the
 * most events among all periods p where sig[i] == sig[i+p] holds for a run of at
 * least two full repetitions.
 */
function findDominantRepeat(sigs: string[]): { period: number; reps: number; start: number } | null {
  const n = sigs.length;
  let best: { period: number; reps: number; start: number; span: number } | null = null;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    let i = 0;
    while (i + p < n) {
      if (sigs[i] === sigs[i + p]) {
        let j = i;
        while (j + p < n && sigs[j] === sigs[j + p]) j++;
        // matched indices [i, j] via period p → run length is (j - i + p)
        const runLen = j - i + p;
        const reps = Math.floor(runLen / p);
        if (reps >= 2) {
          const span = reps * p;
          if (!best || span > best.span) best = { period: p, reps, start: i, span };
        }
        i = j + 1;
      } else {
        i++;
      }
    }
  }
  return best ? { period: best.period, reps: best.reps, start: best.start } : null;
}

/**
 * Compact a raw trace: drop noise, then tag the dominant repeated block's events
 * with repeatGroup: 1 so the distiller can emit a single loop step.
 */
export function compactTrace(rawEvents: TraceEvent[]): CompactResult {
  const events = dropNoise(rawEvents).map((e) => ({ ...e }));
  const sigs = events.map(eventSignature);
  const dominant = findDominantRepeat(sigs);
  let repeatGroups = 0;
  if (dominant) {
    repeatGroups = 1;
    const end = dominant.start + dominant.reps * dominant.period;
    for (let i = dominant.start; i < end && i < events.length; i++) {
      events[i]!.repeatGroup = 1;
    }
  }
  return { events, repeatGroups, dominant };
}
