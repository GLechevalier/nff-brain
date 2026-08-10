import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Grab-to-pan + wheel-zoom for an inline SVG canvas — ported from nff-admin's
// pointer-events version: one finger/mouse pans, two fingers pinch-zoom about
// the gesture midpoint, wheel zooms on desktop. The caller must set
// `touch-action: none` on the SVG. No setPointerCapture: it would retarget the
// eventual `click` and break node selection. The auto-fit is one-shot per
// fitKey and waits for a non-zero panel size (webviews can mount hidden).

export interface PanZoomView {
  tx: number;
  ty: number;
  scale: number;
}

export interface FitBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface UsePanZoomOptions {
  fit?: FitBox | null;
  fitKey?: string;
  padding?: number;
  minScale?: number;
  maxScale?: number;
}

export interface PanZoom {
  view: PanZoomView;
  panning: boolean;
  svgRef: React.RefObject<SVGSVGElement>;
  movedRef: React.MutableRefObject<boolean>;
  startPan: (e: React.PointerEvent) => void;
  resetView: () => void;
}

export function usePanZoom(opts: UsePanZoomOptions = {}): PanZoom {
  const { fit = null, fitKey = '', padding = 48, minScale = 0.2, maxScale = 2.5 } = opts;

  const [view, setView] = useState<PanZoomView>({ tx: 0, ty: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const movedRef = useRef(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fittedKeyRef = useRef<string | null>(null);

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<
    | { mode: 'pan'; base: PanZoomView; startX: number; startY: number }
    | { mode: 'pinch'; base: PanZoomView; startDist: number; startMidX: number; startMidY: number }
    | null
  >(null);
  const listenersOnRef = useRef(false);

  const onMoveRef = useRef<(ev: PointerEvent) => void>(() => {});
  const onUpRef = useRef<(ev: PointerEvent) => void>(() => {});

  onMoveRef.current = (ev: PointerEvent) => {
    if (!pointersRef.current.has(ev.pointerId)) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointersRef.current.set(ev.pointerId, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    const g = gestureRef.current;
    if (!g) return;
    if (g.mode === 'pan') {
      const p = pointersRef.current.get(ev.pointerId)!;
      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      setView({ ...g.base, tx: g.base.tx + dx, ty: g.base.ty + dy });
    } else {
      const [a, b] = [...pointersRef.current.values()];
      if (!b) return;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const scale = Math.min(maxScale, Math.max(minScale, g.base.scale * (dist / g.startDist)));
      const k = scale / g.base.scale;
      setView({ scale, tx: mx - (g.startMidX - g.base.tx) * k, ty: my - (g.startMidY - g.base.ty) * k });
    }
  };

  onUpRef.current = (ev: PointerEvent) => {
    if (!pointersRef.current.delete(ev.pointerId)) return;
    const remaining = [...pointersRef.current.values()];
    if (remaining.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        base: viewRef.current,
        startX: remaining[0].x,
        startY: remaining[0].y,
      };
    } else if (remaining.length === 0) {
      gestureRef.current = null;
      setPanning(false);
      listenersOnRef.current = false;
      document.removeEventListener('pointermove', docMove);
      document.removeEventListener('pointerup', docUp);
      document.removeEventListener('pointercancel', docUp);
    }
  };

  const docMove = useCallback((ev: PointerEvent) => onMoveRef.current(ev), []);
  const docUp = useCallback((ev: PointerEvent) => onUpRef.current(ev), []);

  const startPan = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      e.preventDefault();
      pointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

      const pts = [...pointersRef.current.values()];
      if (pts.length === 1) {
        movedRef.current = false;
        gestureRef.current = { mode: 'pan', base: viewRef.current, startX: pts[0].x, startY: pts[0].y };
      } else if (pts.length === 2) {
        movedRef.current = true; // a pinch must never count as a node click
        const [a, b] = pts;
        gestureRef.current = {
          mode: 'pinch',
          base: viewRef.current,
          startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
          startMidX: (a.x + b.x) / 2,
          startMidY: (a.y + b.y) / 2,
        };
      }
      setPanning(true);

      if (!listenersOnRef.current) {
        listenersOnRef.current = true;
        document.addEventListener('pointermove', docMove);
        document.addEventListener('pointerup', docUp);
        document.addEventListener('pointercancel', docUp);
      }
    },
    [docMove, docUp],
  );

  // Wheel-zoom about the cursor. Non-passive so we can preventDefault page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
        const k = scale / v.scale;
        return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [minScale, maxScale]);

  const fitNow = useCallback(() => {
    const box = fitRef.current;
    const r = svgRef.current?.getBoundingClientRect();
    const w = r?.width ?? 800;
    const h = r?.height ?? 600;
    if (!box) {
      setView({ tx: 0, ty: 0, scale: 1 });
      return;
    }
    const cw = Math.max(box.maxX - box.minX, 1);
    const ch = Math.max(box.maxY - box.minY, 1);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const scale = Math.min(
      maxScale,
      Math.max(minScale, Math.min((w - 2 * padding) / cw, (h - 2 * padding) / ch)),
    );
    setView({ tx: w / 2 - cx * scale, ty: h / 2 - cy * scale, scale });
  }, [padding, minScale, maxScale]);

  const resetView = useCallback(() => fitNow(), [fitNow]);

  // Auto-fit ONCE per fitKey, when the panel actually has a size — rAF covers
  // "visible on load", the ResizeObserver covers "shown later / resized".
  useEffect(() => {
    if (!fit) return;
    if (fittedKeyRef.current === fitKey) return;
    const el = svgRef.current;
    if (!el) return;
    const tryFit = () => {
      if (fittedKeyRef.current === fitKey) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fittedKeyRef.current = fitKey;
        fitNow();
      }
    };
    const id = requestAnimationFrame(tryFit);
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [fit, fitKey, fitNow]);

  return { view, panning, svgRef, movedRef, startPan, resetView };
}
