import type React from 'react';
import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react';
import type { ViewEdge, ViewNode } from '../src/protocol';
import { hash, layoutBrain } from './brainSpacing';
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
  onHover: (id: string | null) => void;
  /** Positions the layout settled for nodes that arrived without one, for persisting. */
  onLayout?: (positions: Array<{ id: string; x: number; y: number }>) => void;
  emptyState?: React.ReactNode;
}

export const BrainGraph = forwardRef<BrainGraphHandle, BrainGraphProps>(function BrainGraph(
  { nodes, edges, selectedId, hoveredId, matchedIds, glow, onSelect, onHover, onLayout, emptyState },
  ref,
) {
  // The central hub is pinned during spacing so the graph keeps its anchor.
  const coreId = useMemo(() => nodes.find((n) => n.category === 'core')?.id ?? null, [nodes]);

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
    () => layoutBrain(nodes, edges, { incremental: true, minGap: 60, pinnedId: coreId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, coreId],
  );

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
    for (const n of nodes) {
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
    // 560x400 random box), so the fit scale needs room to go further out.
    minScale: 0.05,
    maxScale: 2.5,
  });

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
      ref={svgRef}
      onPointerDown={startPan}
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
        {edges.map((edge, i) => {
          const from = nodeMap[edge.from];
          const to = nodeMap[edge.to];
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
          const dimmed = matchedIds != null && !(matchedIds.has(edge.from) && matchedIds.has(edge.to));
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
          nodes.map((node) => {
            const g = glow.get(node.id);
            const p = nodeMap[node.id];
            if (!g || !p) return null;
            const pad = 6;
            return (
              // Drift lives on a wrapper, not the halo itself: the halo already
              // animates transform (nb-arrive scales it), and a second transform
              // animation on one element would clobber it. Nesting composes them.
              <g key={`glow-${node.id}`} className="nb-drift" style={driftVars(node.id, g)}>
                <rect
                  className={`nb-glow${g.fresh ? ' nb-glow--fresh' : ''}`}
                  x={p.x - node.size - pad}
                  y={p.y - node.size - pad}
                  width={(node.size + pad) * 2}
                  height={(node.size + pad) * 2}
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
        {nodes.map((node) => {
          const p = nodeMap[node.id];
          if (!p) return null;
          const isSelected = node.id === selectedId;
          const isHovered = node.id === hoveredId && !isSelected;
          const dimmed = matchedIds != null && !matchedIds.has(node.id);
          // Hot nodes wander; cold ones carry no class at all, so a quiet graph
          // is exactly as static as before.
          const g = glow?.get(node.id);
          return (
            <g
              key={node.id}
              opacity={dimmed ? 0.2 : 1}
              className={g ? 'nb-drift' : undefined}
              style={{ cursor: 'pointer', ...(g ? driftVars(node.id, g) : null) }}
              // Guard against a pan-drag that ends over a node mis-selecting it.
              onClick={() => {
                if (!movedRef.current) onSelect(node.id);
              }}
              onMouseEnter={() => onHover(node.id)}
              onMouseLeave={() => onHover(null)}
            >
              <rect
                x={p.x - node.size}
                y={p.y - node.size}
                width={node.size * 2}
                height={node.size * 2}
                fill={isSelected ? INK : isHovered ? HOVER : PAPER}
                stroke={INK}
                strokeWidth={isSelected ? 0 : 1}
              />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={node.size > 20 ? 13 : 9}
                fill={isSelected ? PAPER : INK}
                fontFamily="var(--nb-mono)"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {CATEGORY_ICON[node.category] ?? '·'}
              </text>
              <text
                x={p.x}
                y={p.y + node.size + 13}
                textAnchor="middle"
                fontSize={10}
                fill={INK}
                fontFamily="var(--nb-mono)"
                fontWeight={isSelected ? 'bold' : 'normal'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.title}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
});
