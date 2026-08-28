// The activity stream's pure half: event shape, line parsing and the glow
// timing math the webview animates with. This module must stay free of node:*
// imports — the webview bundles it via the '@nff-brain/core/activity' subpath
// (like './score'), and node:fs would break the browser build. The fs side
// lives in activityStore.ts.

export type ActivityKind = 'recall' | 'prompt' | 'search' | 'expand' | 'distill';

const KINDS: ReadonlySet<string> = new Set(['recall', 'prompt', 'search', 'expand', 'distill']);

export interface ActivityEvent {
  v: 1;
  at: string; // ISO timestamp
  kind: ActivityKind;
  ids: string[]; // ordered — recall lists seeds first, so index order = wave order
  seedCount?: number; // recall only; equals ids.length on the whole-graph bypass
  sessionId?: string;
}

/**
 * Parse a chunk of activity.jsonl. Tolerant by design: a torn tail from a
 * crashed writer, a garbage line, or an event kind from a future version is
 * skipped, never thrown on.
 */
export function parseActivityLines(chunk: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as ActivityEvent;
      if (
        e !== null &&
        typeof e === 'object' &&
        e.v === 1 &&
        typeof e.kind === 'string' &&
        KINDS.has(e.kind) &&
        Array.isArray(e.ids) &&
        e.ids.every((id) => typeof id === 'string') &&
        typeof e.at === 'string' &&
        Number.isFinite(Date.parse(e.at))
      ) {
        events.push(e);
      }
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return events;
}

// ── glow timing ──────────────────────────────────────────────────────────────
// A touched node flares, then breathes while its heat decays exponentially.

export const GLOW_TAU_MS = 240_000; // e-folding time; visible lifetime ≈ 12 min
export const GLOW_FLOOR = 0.05; // below this the halo unmounts

/** Heat of a touch `ageMs` ago, 0..1; 0 once fully faded. */
export function glowIntensity(ageMs: number, tauMs = GLOW_TAU_MS): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const i = Math.exp(-ageMs / tauMs);
  return i < GLOW_FLOOR ? 0 : i;
}

/**
 * Stagger for the arrival ripple: node `index` of `count` starts its flare
 * this many ms late. Per-node gap is 120ms but the whole wave is capped at
 * ~2.5s so a whole-graph recall (small brains inject everything) reads as one
 * sweep, not a minute of popcorn.
 */
export function waveDelayMs(index: number, count: number): number {
  return Math.max(0, index) * Math.min(120, 2500 / Math.max(count, 1));
}

/** Breathing slows as the node cools: 2.4s when hot, 6s when nearly faded. */
export function breathePeriodMs(intensity: number): number {
  const t = Math.min(1, Math.max(0, intensity));
  return Math.round(6000 - t * (6000 - 2400));
}

// ── glow heat map ────────────────────────────────────────────────────────────
// The decay/recompute step every glow UI (the VS Code webview, nff-admin's
// brain graph) needs on top of the timing math above. Framework-free — each
// caller owns its own heat Map and re-render trigger; this just does the math.

export interface Heat {
  at: number; // epoch ms of the touch
  base: number; // starting intensity (by event kind)
  delayMs: number; // wave stagger for the arrival flash
}

export interface GlowInfo {
  intensity: number; // 0..1 current (decayed) heat — drives opacity
  fresh: boolean; // touched <4s ago → arrival flash + wave stagger
  delayMs: number; // wave stagger for the arrival flash
  periodMs: number; // breathing period, slows as the node cools
}

export const GLOW_FRESH_MS = 4_000;

/**
 * Decay every tracked touch to its current GlowInfo as of `now`, deleting
 * (mutating `heat`) anything that has cooled past GLOW_FLOOR so its halo
 * unmounts. Pure aside from that prune — callers own the Map and their own
 * re-render trigger (a 10s tick is typical; see useActivityGlow.ts).
 */
export function recomputeGlow(heat: Map<string, Heat>, now: number): Map<string, GlowInfo> {
  const next = new Map<string, GlowInfo>();
  for (const [id, h] of heat) {
    const age = now - h.at;
    const intensity = h.base * glowIntensity(age);
    if (intensity < GLOW_FLOOR) {
      heat.delete(id);
      continue;
    }
    next.set(id, {
      intensity,
      fresh: age < GLOW_FRESH_MS,
      delayMs: h.delayMs,
      periodMs: breathePeriodMs(intensity),
    });
  }
  return next;
}
