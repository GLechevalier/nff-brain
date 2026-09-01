import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ViewEdge, ViewNode } from '../src/protocol';
import {
  buildDensityClusters,
  buildSpine,
  hash,
  isDensityClusterId,
  layoutBrain,
  MERGE_SCREEN_SLACK,
  resolveRoot,
  type SpineNode,
} from './brainSpacing';
import { usePanZoom, type FitBox } from './usePanZoom';
import type { GlowInfo } from './useActivityGlow';

// The brain knowledge-graph renderer, ported from nff-dashboard's
// BrainGraph.tsx. Pure SVG; node x/y are board coordinates; grab-to-pan /
// scroll-to-zoom. The only change from the dashboard: literal monochrome colors
// became VS Code theme variables (--nb-*), so the look inverts correctly in
// dark themes.
//
// Positions come from the force-directed layout in core, run incrementally:
// nodes already settled keep their exact coordinates and only new ones are
// placed, so the arrangement the reader has learned survives a node being
// added. App.tsx sends the settled positions back to the host to persist.

// Category is conveyed SOLELY by this glyph (the webview renders theme colors,
// not node.color), so every category in core's CATEGORIES needs one. Fall back
// to '·' rather than rendering a blank square if the two ever drift.
const CATEGORY_ICON: Record<ViewNode['category'], string> = {
  core: '◈',
  analysis: '⊕',
  rules: '▦',
  strategy: '↑',
  decision: '⌘',
  preference: '☺',
  task: '☐',
};

const INK = 'var(--nb-ink)';
const PAPER = 'var(--nb-paper)';
const HOVER = 'var(--nb-hover)';
const FAINT = 'var(--nb-faint)';

function edgeStyle(strength: number): { offsets: number[]; width: number; dash?: string } {
  if (strength >= 0.95) return { offsets: [-2.5, 0, 2.5], width: 1 }; // triple bold
  if (strength >= 0.75) return { offsets: [-1.5, 1.5], width: 1 }; // double
  if (strength >= 0.63) return { offsets: [0], width: 1.5 }; // single solid
  return { offsets: [0], width: 0.75, dash: '4 4' }; // dotted
}

// Drift parameters for one hot node. The halo wrapper and the node group both
// take this SAME object, so they stay in phase and the glow never detaches from
// its square. Two bits of the id hash pick one of four wander directions; the
// period and wave delay are the halo's own, so motion and light breathe together.
function driftVars(id: string, g: GlowInfo): React.CSSProperties {
  const h = hash(id);
  return {
    '--nb-glow-i': String(g.intensity),
    '--nb-jx': h & 1 ? '1' : '-1',
    '--nb-jy': h & 2 ? '1' : '-1',
    '--nb-drift-period': `${g.periodMs}ms`,
    animationDelay: `${g.delayMs}ms`,
  } as React.CSSProperties;
}

/** Greedy word wrap — SVG <text> has no wrapping, so each line is its own element. */
function wrapText(text: string, cols: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length > 0 && line.length + 1 + word.length > cols) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 6); // a label, not an essay
}

export interface BrainGraphHandle {
  resetView: () => void;
  zoomBy: (factor: number) => void;
  focusNode: (id: string) => void;
}

interface BrainGraphProps {
  nodes: ViewNode[];
  edges: ViewEdge[];
  selectedId: string | null;
  hoveredId: string | null;
  /** Search results: null/undefined = search inactive, everything full opacity. */
  matchedIds?: ReadonlySet<string> | null;
  /** Live-activity heat: nodes the agent recently looked at glow and breathe. */
  glow?: ReadonlyMap<string, GlowInfo>;
  onSelect: (id: string) => void;
  /** Shift-drag box-selected 2+ real nodes at once — their ids, in no particular order. */
  onMultiSelect?: (ids: string[]) => void;
  /** The parent's current box-selection, if any — rendered with the same highlight as selectedId. */
  multiSelectedIds?: ReadonlySet<string>;
  onHover: (id: string | null) => void;
  /** Positions the layout settled for nodes that arrived without one, for persisting. */
  onLayout?: (positions: Array<{ id: string; x: number; y: number }>) => void;
  /** A node the reader dragged to a new spot, dropped — always overwrites, unlike onLayout. */
  onMove?: (positions: Array<{ id: string; x: number; y: number }>) => void;
  /** Live zoom level, for the header readout. An imperative handle can't do this — it isn't reactive. */
  onScaleChange?: (scale: number) => void;
  emptyState?: React.ReactNode;
}

export const BrainGraph = forwardRef<BrainGraphHandle, BrainGraphProps>(function BrainGraph(
  {
    nodes,
    edges,
    selectedId,
    hoveredId,
    matchedIds,
    glow,
    onSelect,
    onMultiSelect,
    multiSelectedIds,
    onHover,
    onLayout,
    onMove,
    onScaleChange,
    emptyState,
  },
  ref,
) {
  // The root is pinned during spacing so the graph keeps its anchor. Resolved
  // by resolveRoot rather than `find(category === 'core')`: graphify imports
  // its "god" nodes as core too, so that find was an array-order lottery that
  // could pin the whole board to something like test_wokwi.py.
  const coreId = useMemo(() => resolveRoot(nodes, edges), [nodes, edges]);

  // The navigational spine — derived here, never persisted. It links every
  // island of the graph to the root through grouping nodes.
  const spine = useMemo(() => buildSpine(nodes, edges), [nodes, edges]);

  // Memoized on the node set AND the edge set — edges drive the layout now, so
  // keying on nodes alone would leave a new connection unrendered until
  // something else happened to change a position.
  const layoutKey = useMemo(
    () =>
      nodes
        .map((n) => `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${n.size}:${n.laidOut ? 1 : 0}`)
        .join('|') +
      '#' +
      edges.map((e) => `${e.from}>${e.to}:${e.strength}`).join('|'),
    [nodes, edges],
  );
  const laidOut = useMemo(
    // minGap is left to core's default so the webview and `nff-brain layout`
    // cannot drift apart on spacing.
    () => layoutBrain(nodes, edges, { incremental: true, pinnedId: coreId, spine }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, coreId, spine],
  );

  // Spine nodes carry their own positions and their own hit-testing; keep them
  // out of everything keyed on ViewNode.
  const spineLaidOut = useMemo(
    () => spine.nodes.map((s) => ({ s, p: laidOut[s.id] })).filter((e) => e.p),
    [spine, laidOut],
  );
  // Spine selection is LOCAL: a grouping node is navigation, not knowledge, so
  // clicking one must not ask the host to open a document that cannot exist.
  const [spineSel, setSpineSel] = useState<string | null>(null);
  const [spineHover, setSpineHover] = useState<string | null>(null);
  /** Members of the focused grouping node — everything else dims to show its reach. */
  const spineFocus = useMemo(() => {
    const id = spineSel ?? spineHover;
    const s = id ? spine.nodes.find((n) => n.id === id) : null;
    return s ? new Set(s.memberIds) : null;
  }, [spine, spineSel, spineHover]);
  // A grouping node that disappears (islands merged, graph changed) must not
  // leave the board dimmed forever.
  useEffect(() => {
    if (spineSel && !spine.nodes.some((n) => n.id === spineSel)) setSpineSel(null);
  }, [spine, spineSel]);

  // Hand the settled coordinates up so they can be persisted. Only nodes that
  // arrived without one are reported: everything else is already on disk, and
  // re-sending it would write the file on every render.
  const settledForNodes = useMemo(() => {
    const out: Array<{ id: string; x: number; y: number }> = [];
    for (const n of nodes) {
      if (n.laidOut) continue;
      const p = laidOut[n.id];
      if (p) out.push({ id: n.id, x: p.x, y: p.y });
    }
    return out;
  }, [nodes, laidOut]);

  useEffect(() => {
    if (settledForNodes.length > 0) onLayout?.(settledForNodes);
  }, [settledForNodes, onLayout]);

  const fit = useMemo<FitBox | null>(() => {
    if (nodes.length === 0) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    // Spine nodes sit on the outer rings, so the fit box has to include them or
    // the view frames only part of the tree.
    for (const n of [...nodes, ...spine.nodes]) {
      const p = laidOut[n.id];
      if (!p) continue;
      minX = Math.min(minX, p.x - n.size);
      minY = Math.min(minY, p.y - n.size);
      maxX = Math.max(maxX, p.x + n.size);
      maxY = Math.max(maxY, p.y + n.size + 20); // label sits below the square
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, [nodes, laidOut]);

  // Re-arm the one-shot auto-fit when the node-id set changes (add / remove /
  // merge) OR when the layout moves the board. The id set alone is not enough:
  // a re-layout can change the extent by an order of magnitude while keeping
  // every id, which would leave the view framed on a box that no longer exists.
  // Rounded to 50px so ordinary settling doesn't re-fit under the reader.
  const fitKey = useMemo(() => {
    const ids = nodes.map((n) => n.id).sort().join(',');
    if (!fit) return ids;
    const q = (v: number) => Math.round(v / 50);
    return `${ids}#${q(fit.minX)},${q(fit.minY)},${q(fit.maxX)},${q(fit.maxY)}`;
  }, [nodes, fit]);

  const { view, panning, svgRef, movedRef, startPan, resetView, zoomBy, centerOn } = usePanZoom({
    fit,
    fitKey,
    padding: 56,
    // The packed layout spans a few thousand px on a real brain (vs the old
    // 560x400 random box), so the fit scale needs room to go further out —
    // and, because fit then lands near 0.1, much further IN before a single
    // node is readable. The old 2.5x ceiling was nowhere near enough.
    minScale: 0.05,
    maxScale: 8,
  });

  // Report the live zoom level up for the header readout.
  useEffect(() => {
    onScaleChange?.(view.scale);
  }, [view.scale, onScaleChange]);

  // Shift-drag box-select: a plain drag on empty canvas still pans (startPan,
  // unchanged) — only a shift-held drag starts a marquee instead. Board-space
  // corners, so the drawn box tracks the content under the pan/zoom transform
  // like everything else. The move/up handlers are created fresh per gesture
  // and attached directly to `document` (same "survives leaving the SVG"
  // reasoning as the pan gesture in usePanZoom) — closing over `view`/
  // `visibleNodes`/`nodeMap` from the render the drag started in is fine
  // since none of them move mid-drag.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // svgRef from usePanZoom is a callback ref (deliberately, see its own file's
  // comment), not a RefObject — this local one composes onto the same <svg>
  // just to get a synchronous getBoundingClientRect() read for box-select math.
  const localSvgRef = useRef<SVGSVGElement | null>(null);
  const toBoard = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = localSvgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (clientX - rect.left - view.tx) / view.scale, y: (clientY - rect.top - view.ty) / view.scale };
  };
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!e.shiftKey || e.pointerType !== 'mouse' || e.button !== 0) {
      startPan(e);
      return;
    }
    e.preventDefault();
    const start = toBoard(e.clientX, e.clientY);
    if (!start) return;
    setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });

    const onMove = (ev: PointerEvent) => {
      const p = toBoard(ev.clientX, ev.clientY);
      if (p) setMarquee((m) => (m ? { ...m, x1: p.x, y1: p.y } : m));
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const end = toBoard(ev.clientX, ev.clientY) ?? start;
      const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
      setMarquee(null);
      if (maxX - minX < 3 && maxY - minY < 3) return; // a shift-click, not a drag — no-op
      const hits = visibleNodes
        .filter((n) => {
          const p = nodeMap[n.id];
          return p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
        })
        .map((n) => n.id);
      if (hits.length >= 2) onMultiSelect?.(hits);
      else if (hits.length === 1) onSelect(hits[0]);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // Overlap merging — Agar.io style. Nodes whose squares visually overlap at
  // the current zoom fuse into one blob anchored on the largest member; the
  // anchor stays rendered (grown by core's blobSize) and the other members
  // hide behind it. Derived here, never persisted, same as the spine above;
  // the difference is this one HIDES members instead of drawing a boundary
  // around them. Fed the SETTLED (laid-out) positions, not the raw disk x/y —
  // "stacked" has to mean stacked where it actually renders. The slack is
  // MERGE_SCREEN_SLACK / view.scale, so zooming out coalesces and zooming
  // in dissolves — the same definition every surface uses.
  const densityClusters = useMemo(() => {
    const positioned = nodes.map((n) => {
      const p = laidOut[n.id];
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
    // Core nodes (the hub) are important landmarks: they may anchor blobs
    // but must never be hidden as another blob's member.
    const protectedIds = new Set(positioned.filter((n) => n.category === 'core').map((n) => n.id));
    return buildDensityClusters(positioned, edges, { slack: MERGE_SCREEN_SLACK / view.scale, protectedIds });
  }, [nodes, edges, laidOut, view.scale]);
  // A blob's anchor keeps rendering as itself; only the OTHER members hide.
  const blobByAnchor = useMemo(
    () => new Map(densityClusters.map((c) => [c.anchorId, c])),
    [densityClusters],
  );
  const hiddenIds = useMemo(
    () => new Set(densityClusters.flatMap((c) => c.memberIds.filter((id) => id !== c.anchorId))),
    [densityClusters],
  );
  // A hidden member doesn't just vanish the instant it merges — it stays
  // rendered for one transition, sliding and shrinking into the anchor that
  // ate it, then drops out for good (by then it's sitting invisibly on top
  // of the anchor anyway). memberId -> the anchor id it's animating toward.
  const memberToAnchor = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of densityClusters) for (const id of c.memberIds) if (id !== c.anchorId) m.set(id, c.anchorId);
    return m;
  }, [densityClusters]);
  // A CONTENT signature, not the Map's reference — `densityClusters` gets a
  // fresh object every render regardless of whether membership actually
  // changed (laidOut is rebuilt every render), so depending on the Map
  // itself re-ran this effect — and re-cancelled its own just-armed removal
  // timer via the cleanup below — on almost every render, and an absorbed
  // node's timer never survived long enough to fire: it got added to
  // `absorbing` and then stuck there forever, permanently invisible
  // (opacity 0) instead of reappearing hidden-but-fine behind clusteredIds.
  // The signature alone isn't enough, though — wheel zoom still changes it
  // several times per gesture, cancelling timers — so the effect also prunes
  // any id that un-merged, the only moment stranding becomes visible.
  const mergedKey = useMemo(
    () => [...memberToAnchor.entries()].map(([id, anchor]) => `${id}:${anchor}`).sort().join('|'),
    [memberToAnchor],
  );
  const [absorbing, setAbsorbing] = useState<Map<string, string>>(new Map());
  const prevMergedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newlyAbsorbed = [...memberToAnchor.keys()].filter((id) => !prevMergedRef.current.has(id));
    prevMergedRef.current = new Set(memberToAnchor.keys());
    setAbsorbing((prev) => {
      // An id that left memberToAnchor un-merged (zoom back in): it must leave
      // the farewell state too, or it keeps rendering at the anchor at
      // opacity 0 forever. This prune is also the safety net for batches whose
      // removal timer got cancelled by a mid-gesture mergedKey change — the
      // cleanup below clears the pending timer every time the merge set
      // shifts, and wheel zoom shifts it many times per 500ms window.
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys())
        if (!memberToAnchor.has(id)) { next.delete(id); changed = true; }
      for (const id of newlyAbsorbed) { next.set(id, memberToAnchor.get(id)!); changed = true; }
      return changed ? next : prev;
    });
    if (newlyAbsorbed.length === 0) return;
    const timer = setTimeout(() => {
      setAbsorbing((prev) => {
        const next = new Map(prev);
        for (const id of newlyAbsorbed) next.delete(id);
        return next;
      });
    }, 500); // outlasts the transitions below
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedKey]);

  const visibleNodes = useMemo(
    () => nodes.filter((n) => !hiddenIds.has(n.id) || absorbing.has(n.id)),
    [nodes, hiddenIds, absorbing],
  );
  // Redirect any edge touching a hidden member to its blob's anchor (a real,
  // visible node), dedupe, and drop edges that end up with both ends in the
  // same blob (now-internal). Non-merged edges pass through unchanged.
  const visibleEdges = useMemo(() => {
    if (densityClusters.length === 0) return edges;
    const seen = new Set<string>();
    const out: ViewEdge[] = [];
    for (const e of edges) {
      const from = memberToAnchor.get(e.from) ?? e.from;
      const to = memberToAnchor.get(e.to) ?? e.to;
      if (from === to) continue;
      const key = `${from}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, from, to });
    }
    return out;
  }, [edges, densityClusters, memberToAnchor]);
  // An anchor renders at the blob's grown size (core's blobSize, already
  // computed on the cluster); everything else at its own.
  const renderSizeFor = (n: { id: string; size: number }) => blobByAnchor.get(n.id)?.size ?? n.size;
  // Which blob's member list is open, if any. Local UI state, not knowledge.
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  useEffect(() => {
    if (expandedClusterId && !densityClusters.some((c) => c.id === expandedClusterId)) {
      setExpandedClusterId(null);
    }
  }, [densityClusters, expandedClusterId]);

  useImperativeHandle(
    ref,
    () => ({
      resetView,
      zoomBy,
      // Center on the LAID-OUT coordinates — raw node.x/y is the position on
      // disk, which for a node the layout just placed is not where it renders.
      focusNode: (id: string) => {
        const p = laidOut[id];
        if (p) centerOn(p.x, p.y);
      },
    }),
    [resetView, zoomBy, centerOn, laidOut],
  );

  // Memoized: the glow's 10s decay tick re-renders this component, and
  // rebuilding the map every render would allocate for nothing.
  const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, laidOut[n.id]])), [nodes, laidOut]);

  // ── node drag ────────────────────────────────────────────────────────────
  // A dragged node's live position, overriding nodeMap while the gesture is in
  // flight. Cleared once `nodes`/`laidOut` catches up to the dropped spot, so
  // the square doesn't spring back to its pre-drag position while the `move`
  // message round-trips through the host.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ id: string; clientX: number; clientY: number; x0: number; y0: number } | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    if (!drag) return;
    const p = nodeMap[drag.id];
    if (p && Math.abs(p.x - drag.x) < 0.5 && Math.abs(p.y - drag.y) < 0.5) setDrag(null);
  }, [nodeMap, drag]);

  // Edges/glow must track a node mid-drag too, or its connections visually
  // detach from it while it's being moved.
  const posFor = useCallback(
    (id: string) => (drag?.id === id ? drag : nodeMap[id]),
    [drag, nodeMap],
  );

  const startNodeDrag = useCallback(
    (e: React.PointerEvent, id: string, x0: number, y0: number) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation(); // a node drag must never also start a canvas pan
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      dragMovedRef.current = false;
      dragStartRef.current = { id, clientX: e.clientX, clientY: e.clientY, x0, y0 };
    },
    [],
  );

  const moveNodeDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      const s = dragStartRef.current;
      if (!s || s.id !== id) return;
      const dx = (e.clientX - s.clientX) / view.scale;
      const dy = (e.clientY - s.clientY) / view.scale;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMovedRef.current = true;
      setDrag({ id, x: s.x0 + dx, y: s.y0 + dy });
    },
    [view.scale],
  );

  const endNodeDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      const s = dragStartRef.current;
      if (!s || s.id !== id) return;
      dragStartRef.current = null;
      if (dragMovedRef.current) {
        const dx = (e.clientX - s.clientX) / view.scale;
        const dy = (e.clientY - s.clientY) / view.scale;
        onMove?.([{ id, x: s.x0 + dx, y: s.y0 + dy }]);
      } else {
        setDrag(null);
      }
    },
    [view.scale, onMove],
  );

  if (nodes.length === 0 && emptyState) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: PAPER,
        }}
      >
        {emptyState}
      </div>
    );
  }

  return (
    <svg
      ref={(el) => { svgRef(el); localSvgRef.current = el; }}
      onPointerDown={handlePointerDown}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        cursor: panning ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
    >
      <rect x={0} y={0} width="100%" height="100%" fill={PAPER} />
      <defs>
        <filter id="nb-blur" x="-75%" y="-75%" width="250%" height="250%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
        {/* The spine, drawn FIRST so it sits behind the real graph. These links
            are derived scaffolding, not knowledge — thin, dashed and faint, so
            they read as "how to get there", never as a fact the brain holds. */}
        {spine.edges.map((e, i) => {
          const from = laidOut[e.from];
          const to = laidOut[e.to];
          if (!from || !to) return null;
          return (
            <line
              key={`spine-${i}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={FAINT}
              strokeWidth={0.75}
              strokeDasharray="2 6"
              opacity={spineFocus ? 0.35 : 0.7}
            />
          );
        })}
        {spineLaidOut.map(({ s, p }) => {
          const isSel = s.id === spineSel;
          const r = s.size;
          return (
            <g
              key={s.id}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                if (movedRef.current) return;
                setSpineSel((cur) => (cur === s.id ? null : s.id));
              }}
              onMouseEnter={() => setSpineHover(s.id)}
              onMouseLeave={() => setSpineHover(null)}
            >
              {/* A diamond, so a grouping node is never mistaken for a real
                  square one — the shape carries the distinction, not a colour. */}
              <polygon
                points={`${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`}
                fill={isSel ? INK : PAPER}
                stroke={INK}
                strokeWidth={1}
                strokeDasharray={isSel ? undefined : '3 3'}
              />
              <text
                x={p.x}
                y={p.y + r + 13}
                textAnchor="middle"
                fontSize={10}
                fill={INK}
                fontFamily="var(--nb-mono)"
                fontWeight={isSel ? 'bold' : 'normal'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {s.title}
              </text>
              {/* What is under this node, spelled out. Only on selection: shown
                  always it would be a wall of text across the whole board. */}
              {isSel &&
                wrapText(s.summary, 46).map((line, li) => (
                  <text
                    key={li}
                    x={p.x}
                    y={p.y + r + 27 + li * 12}
                    textAnchor="middle"
                    fontSize={9}
                    fill={INK}
                    fontFamily="var(--nb-mono)"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {line}
                  </text>
                ))}
              <title>{`${s.title}\n${s.summary}\n\n(derived grouping — not a node in your brain)`}</title>
            </g>
          );
        })}
        {visibleEdges.map((edge, i) => {
          const from = posFor(edge.from);
          const to = posFor(edge.to);
          if (!from || !to) return null;
          const isActive =
            edge.from === selectedId || edge.to === selectedId ||
            edge.from === hoveredId || edge.to === hoveredId;
          const stroke = isActive ? INK : FAINT;
          const { offsets, width, dash } = edgeStyle(edge.strength);
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const px = len > 0 ? -dy / len : 0;
          const py = len > 0 ? dx / len : 0;
          const dimmed =
            (matchedIds != null && !(matchedIds.has(edge.from) && matchedIds.has(edge.to))) ||
            (spineFocus != null && !(spineFocus.has(edge.from) && spineFocus.has(edge.to)));
          return (
            <g key={i} opacity={dimmed ? 0.15 : 1}>
              {offsets.map((o, j) => (
                <line
                  key={j}
                  x1={from.x + px * o}
                  y1={from.y + py * o}
                  x2={to.x + px * o}
                  y2={to.y + py * o}
                  stroke={stroke}
                  strokeWidth={width}
                  strokeDasharray={dash}
                />
              ))}
            </g>
          );
        })}
        {/* Activity halos — BEHIND the ink squares so a hot node glows around
            its edges. Square (not round) to keep the ink-on-paper geometry.
            All motion is CSS keyframes; React only sets --nb-glow-i and the
            timing parameters, at most every 10s. */}
        {glow &&
          visibleNodes.map((node) => {
            const g = glow.get(node.id);
            const p = posFor(node.id);
            if (!g || !p) return null;
            const size = renderSizeFor(node);
            const pad = 6;
            return (
              // Drift lives on a wrapper, not the halo itself: the halo already
              // animates transform (nb-arrive scales it), and a second transform
              // animation on one element would clobber it. Nesting composes them.
              <g key={`glow-${node.id}`} className="nb-drift" style={driftVars(node.id, g)}>
                <rect
                  className={`nb-glow${g.fresh ? ' nb-glow--fresh' : ''}`}
                  x={p.x - size - pad}
                  y={p.y - size - pad}
                  width={(size + pad) * 2}
                  height={(size + pad) * 2}
                  filter="url(#nb-blur)"
                  style={
                    {
                      '--nb-glow-i': String(g.intensity),
                      // Fresh: two delays — the arrival flash rides the wave, the
                      // breathing starts once the 900ms flash hands over.
                      animationDelay: g.fresh ? `${g.delayMs}ms, ${g.delayMs + 900}ms` : undefined,
                      animationDuration: g.fresh ? undefined : `${g.periodMs}ms`,
                    } as React.CSSProperties
                  }
                />
              </g>
            );
          })}
        {visibleNodes.map((node) => {
          const isDragging = drag?.id === node.id;
          // Just absorbed into a merged cluster — animate toward the hub
          // that ate it instead of vanishing outright: render AT the hub's
          // position, shrunk to nearly nothing, faded to 0 opacity. The x/y/
          // width/height/opacity CSS transitions do the actual sliding —
          // React just moves the target, the browser tweens it.
          const absorbTarget = absorbing.get(node.id);
          const p = isDragging ? drag : absorbTarget ? (nodeMap[absorbTarget] ?? nodeMap[node.id]) : nodeMap[node.id];
          if (!p) return null;
          const isSelected = node.id === selectedId || !!multiSelectedIds?.has(node.id);
          const isHovered = node.id === hoveredId && !isSelected;
          const dimmed =
            (matchedIds != null && !matchedIds.has(node.id)) ||
            (spineFocus != null && !spineFocus.has(node.id));
          // Hot nodes wander; cold ones carry no class at all, so a quiet graph
          // is exactly as static as before.
          const g = glow?.get(node.id);
          // The anchor of an overlap blob renders grown — as if it ate its
          // hidden members (which is exactly what happened).
          const blob = blobByAnchor.get(node.id);
          const size = absorbTarget ? 2 : renderSizeFor(node);
          return (
            <g
              key={node.id}
              opacity={absorbTarget ? 0 : dimmed ? 0.2 : 1}
              className={g && !isDragging ? 'nb-drift' : undefined}
              style={{
                cursor: absorbTarget ? 'default' : isDragging ? 'grabbing' : 'grab',
                pointerEvents: absorbTarget ? 'none' : undefined,
                transition: 'opacity 400ms ease',
                ...(g && !isDragging ? driftVars(node.id, g) : null),
              }}
              onPointerDown={(e) => startNodeDrag(e, node.id, p.x, p.y)}
              onPointerMove={(e) => moveNodeDrag(e, node.id)}
              onPointerUp={(e) => endNodeDrag(e, node.id)}
              // Guard against a pan-drag (or a node-drag) that ends over a node
              // mis-selecting it.
              onClick={() => {
                if (dragMovedRef.current) {
                  dragMovedRef.current = false; // swallow the click a drag-drop triggers
                  return;
                }
                if (movedRef.current) return;
                setSpineSel(null); // picking a real node drops the group focus
                onSelect(node.id);
              }}
              // A blob anchor's double-click toggles its absorbed-members popover.
              onDoubleClick={() => {
                if (movedRef.current || !blob) return;
                setExpandedClusterId((cur) => (cur === blob.id ? null : blob.id));
              }}
              onMouseEnter={() => onHover(node.id)}
              onMouseLeave={() => onHover(null)}
            >
              <rect
                x={p.x - size}
                y={p.y - size}
                width={size * 2}
                height={size * 2}
                fill={isSelected ? INK : isHovered ? HOVER : PAPER}
                stroke={INK}
                strokeWidth={isSelected ? 0 : 1}
              />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={size > 20 ? 13 : 9}
                fill={isSelected ? PAPER : INK}
                fontFamily="var(--nb-mono)"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {CATEGORY_ICON[node.category] ?? '·'}
              </text>
              {/* Company-sync badge: 🔒 private (never synced) / ★ shared
                  (shown in the company brain too). Corner glyph, no layout cost. */}
              {(node.private || node.shared) && (
                <text
                  x={p.x + size}
                  y={p.y - size + 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill={INK}
                  fontFamily="var(--nb-mono)"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {node.private ? '🔒' : '★'}
                </text>
              )}
              <text
                x={p.x}
                y={p.y + size + 13}
                textAnchor="middle"
                fontSize={10}
                fill={INK}
                fontFamily="var(--nb-mono)"
                fontWeight={isSelected ? 'bold' : 'normal'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.title}
              </text>
              {blob && !absorbTarget && (
                <>
                  {/* Mass badge: how many nodes this anchor absorbed. Top-LEFT
                      corner — the private/shared badge owns the top-right. */}
                  <text
                    x={p.x - size}
                    y={p.y - size + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight="bold"
                    fill={INK}
                    fontFamily="var(--nb-mono)"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {`×${blob.memberIds.length - 1}`}
                  </text>
                  <title>
                    {`${blob.summary}\n\n(click selects ${node.title}, double-click lists the absorbed nodes)`}
                  </title>
                </>
              )}
            </g>
          );
        })}
        {/* Open blob popover — drawn LAST so it sits on top of the graph. The
            blob itself is its anchor node, already rendered (grown, with a
            ×N badge) in the node pass above; only the double-click member
            list lives here. */}
        {densityClusters.map((c) => {
          if (c.id !== expandedClusterId) return null;
          const p = nodeMap[c.anchorId];
          if (!p) return null;
          const renderSize = c.size;
          return (
            <foreignObject key={c.id} x={p.x + renderSize + 8} y={p.y - renderSize} width={240} height={c.memberIds.length * 20 + 40}>
              <div
                style={{
                  background: PAPER,
                  border: `1px solid ${INK}`,
                  color: INK,
                  fontFamily: 'var(--nb-mono)',
                  fontSize: 11,
                  padding: 8,
                  maxHeight: c.memberIds.length * 20 + 40,
                  overflowY: 'auto',
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{c.summary}</div>
                {c.memberIds.map((id) => {
                  const n = nodes.find((x) => x.id === id);
                  return (
                    <div
                      key={id}
                      style={{ cursor: 'pointer', padding: '2px 0' }}
                      onClick={() => {
                        setExpandedClusterId(null);
                        onSelect(id);
                      }}
                    >
                      {n?.title ?? id}
                    </div>
                  );
                })}
              </div>
            </foreignObject>
          );
        })}
        {/* Shift-drag box-select — drawn LAST so it's never hidden under a
            node/cluster it's being dragged over. */}
        {marquee && (
          <rect
            x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
            fill={INK} fillOpacity={0.08}
            stroke={INK} strokeWidth={1} strokeDasharray="4 3"
            style={{ pointerEvents: 'none' }}
          />
        )}
      </g>
    </svg>
  );
});
