import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Grab-to-pan + wheel-zoom for an inline SVG canvas — ported from nff-admin's
// pointer-events version: one finger/mouse pans, two fingers pinch-zoom about
// the gesture midpoint, wheel zooms on desktop. The caller must set
// `touch-action: none` on the SVG. No setPointerCapture: it would retarget the
// eventual `click` and break node selection. The auto-fit is one-shot per
// fitKey and waits for a non-zero panel size (webviews can mount hidden).
//
// `svgRef` is a CALLBACK ref, not a RefObject, and that is load-bearing: the
// caller may not render the <svg> on its first pass (BrainGraph shows an empty
// state until the host posts a graph). A RefObject gives effects no signal when
// the element finally mounts, so the wheel listener — whose deps are otherwise
// all constants — silently never attached and zoom was dead. The callback feeds
// `svgEl` state, which effects can depend on. `elRef` keeps the synchronous
// read path for handlers.

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
  svgRef: React.RefCallback<SVGSVGElement>;
  movedRef: React.MutableRefObject<boolean>;
  startPan: (e: React.PointerEvent) => void;
  resetView: () => void;
  zoomBy: (factor: number) => void;
  centerOn: (x: number, y: number, targetScale?: number) => void;
}

// One wheel notch on a mouse is deltaY ±100; a trackpad emits many small deltas,
// and a trackpad PINCH arrives as ctrl+wheel with deltas smaller still. An
// exponential curve keyed off the normalized delta serves all three from one
// formula, where the old fixed ±10% step served only the mouse.
const ZOOM_SENSITIVITY = 0.002;
const PINCH_SENSITIVITY = 0.01;
const MAX_STEP = 2; // no single event may more than double / halve the scale

export function usePanZoom(opts: UsePanZoomOptions = {}): PanZoom {
  const { fit = null, fitKey = '', padding = 48, minScale = 0.2, maxScale = 2.5 } = opts;

  const [view, setView] = useState<PanZoomView>({ tx: 0, ty: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  // See the header note: state (not just a ref) so effects re-run on mount.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const elRef = useRef<SVGSVGElement | null>(null);
  const svgRef = useCallback((el: SVGSVGElement | null) => {
    elRef.current = el;
    setSvgEl(el);
  }, []);
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
    const rect = elRef.current?.getBoundingClientRect();
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
      const rect = elRef.current?.getBoundingClientRect();
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

  // Scale about a point in panel coordinates, keeping that point fixed on screen.
  // The single place the clamp lives — wheel, pinch-by-buttons and keys share it.
  const zoomAbout = useCallback(
    (px: number, py: number, factor: number) => {
      setView((v) => {
        const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
        if (scale === v.scale) return v; // already clamped: don't re-render
        const k = scale / v.scale;
        return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    },
    [minScale, maxScale],
  );

  // Wheel-zoom about the cursor. Non-passive so we can preventDefault page scroll.
  // Depends on svgEl, so it attaches whenever the <svg> mounts — including the
  // late mount after the first (empty-state) render.
  useEffect(() => {
    if (!svgEl) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = svgEl!.getBoundingClientRect();
      // deltaMode: 0 = pixels, 1 = lines, 2 = pages. Normalize to pixels so the
      // step means the same thing across browsers and input devices.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = e.deltaY * unit;
      const s = e.ctrlKey ? PINCH_SENSITIVITY : ZOOM_SENSITIVITY;
      const factor = Math.min(MAX_STEP, Math.max(1 / MAX_STEP, Math.exp(-delta * s)));
      zoomAbout(e.clientX - rect.left, e.clientY - rect.top, factor);
    }
    svgEl.addEventListener('wheel', onWheel, { passive: false });
    return () => svgEl.removeEventListener('wheel', onWheel);
  }, [svgEl, zoomAbout]);

  // Zoom about the panel centre — what the +/- buttons and keys want.
  const zoomBy = useCallback(
    (factor: number) => {
      const r = elRef.current?.getBoundingClientRect();
      zoomAbout((r?.width ?? 800) / 2, (r?.height ?? 600) / 2, factor);
    },
    [zoomAbout],
  );

  const fitNow = useCallback(() => {
    const box = fitRef.current;
    const r = elRef.current?.getBoundingClientRect();
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

  // Center the viewport on a board coordinate, zooming in a little if needed.
  const centerOn = useCallback(
    (x: number, y: number, targetScale?: number) => {
      const r = elRef.current?.getBoundingClientRect();
      const w = r?.width ?? 800;
      const h = r?.height ?? 600;
      const s = Math.min(
        maxScale,
        Math.max(minScale, targetScale ?? Math.max(viewRef.current.scale, 0.8)),
      );
      setView({ scale: s, tx: w / 2 - x * s, ty: h / 2 - y * s });
    },
    [minScale, maxScale],
  );

  // Auto-fit ONCE per fitKey, when the panel actually has a size — rAF covers
  // "visible on load", the ResizeObserver covers "shown later / resized".
  useEffect(() => {
    if (!fit) return;
    if (fittedKeyRef.current === fitKey) return;
    if (!svgEl) return;
    const tryFit = () => {
      if (fittedKeyRef.current === fitKey) return;
      const r = svgEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fittedKeyRef.current = fitKey;
        fitNow();
      }
    };
    const id = requestAnimationFrame(tryFit);
    const ro = new ResizeObserver(tryFit);
    ro.observe(svgEl);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [svgEl, fit, fitKey, fitNow]);

  return { view, panning, svgRef, movedRef, startPan, resetView, zoomBy, centerOn };
}
