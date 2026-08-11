import { useCallback, useEffect, useRef, useState } from 'react';
// Subpath import on purpose (like ./score): the core barrel pulls node:fs and
// would break the browser bundle. activity.ts is dependency-free.
import { breathePeriodMs, glowIntensity, waveDelayMs } from '@nff-brain/core/activity';
import type { ViewActivityEvent, ViewNode } from '../src/protocol';

// The graph's "living system" heat model. Activity events (the agent looked at
// these nodes) charge per-node heat; heat decays exponentially over ~12 min.
// React only re-parameterizes slowly — a 10s tick plus event arrivals — and
// CSS keyframes do all per-frame work, so nothing here runs per frame.

export interface GlowInfo {
  intensity: number; // 0..1 current (decayed) heat — drives opacity via --nb-glow-i
  fresh: boolean; // touched <4s ago → arrival flash + wave stagger
  delayMs: number; // wave stagger for the arrival flash
  periodMs: number; // breathing period, slows as the node cools
}

interface Heat {
  at: number; // epoch ms of the touch
  base: number; // starting intensity (by event kind)
  delayMs: number;
}

const FRESH_MS = 4_000;
const TICK_MS = 10_000;
const FLOOR = 0.05;
const BIG_EVENT_IDS = 20; // whole-graph recall etc. — damp so it reads as a calm wave
const BIG_EVENT_DAMP = 0.6;

function baseIntensity(kind: ViewActivityEvent['kind'], index: number, seedCount: number | undefined): number {
  switch (kind) {
    case 'distill':
      return 1.0; // the brain just LEARNED this
    case 'recall':
      return seedCount !== undefined && index >= seedCount ? 0.6 : 0.85; // seed vs edge-expanded
    case 'search':
      return 0.6;
    default:
      return 0.7; // prompt, expand
  }
}

export function useActivityGlow(nodes: ViewNode[]): {
  glow: ReadonlyMap<string, GlowInfo>;
  visible: boolean;
  onActivity: (events: ViewActivityEvent[], replay: boolean) => void;
} {
  const heatRef = useRef<Map<string, Heat>>(new Map());
  const [glow, setGlow] = useState<ReadonlyMap<string, GlowInfo>>(new Map());
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');

  const recompute = useCallback(() => {
    const now = Date.now();
    const next = new Map<string, GlowInfo>();
    for (const [id, h] of heatRef.current) {
      const age = now - h.at;
      const intensity = h.base * glowIntensity(age);
      if (intensity < FLOOR) {
        heatRef.current.delete(id); // fully cooled — halo unmounts
        continue;
      }
      next.set(id, {
        intensity,
        fresh: age < FRESH_MS,
        delayMs: h.delayMs,
        periodMs: breathePeriodMs(intensity),
      });
    }
    setGlow(next);
  }, []);

  const onActivity = useCallback(
    (events: ViewActivityEvent[], replay: boolean) => {
      const heat = heatRef.current;
      for (const e of events) {
        const at = Date.parse(e.at);
        if (!Number.isFinite(at)) continue;
        const damp = e.ids.length >= BIG_EVENT_IDS ? BIG_EVENT_DAMP : 1;
        e.ids.forEach((id, i) => {
          const prev = heat.get(id);
          if (prev && prev.at > at) return; // newest touch wins
          heat.set(id, {
            at,
            base: baseIntensity(e.kind, i, e.seedCount) * damp,
            // Replayed history arrives already-aged: no wave, no flash.
            delayMs: replay ? 0 : waveDelayMs(i, e.ids.length),
          });
        });
      }
      recompute();
    },
    [recompute],
  );

  // Panel-opens-late fallback beyond the activity log's retention: recall
  // stamps lastRecalledAt on the nodes themselves.
  useEffect(() => {
    const heat = heatRef.current;
    let changed = false;
    for (const n of nodes) {
      if (!n.lastRecalledAt) continue;
      const at = Date.parse(n.lastRecalledAt);
      if (!Number.isFinite(at)) continue;
      const prev = heat.get(n.id);
      if (prev && prev.at >= at) continue;
      heat.set(n.id, { at, base: 0.7, delayMs: 0 });
      changed = true;
    }
    if (changed) recompute();
  }, [nodes, recompute]);

  // Decay tick — paused while the panel is hidden (retainContextWhenHidden
  // keeps us alive in the background; ages are absolute so nothing is lost).
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!visible) return;
    recompute(); // immediate on becoming visible — no stale intensities
    const timer = window.setInterval(recompute, TICK_MS);
    return () => window.clearInterval(timer);
  }, [visible, recompute]);

  return { glow, visible, onActivity };
}
