import type React from 'react';
import { forwardRef, useImperativeHandle, useMemo } from 'react';
import type { ViewEdge, ViewNode } from '../src/protocol';
import { spaceOutNodes } from './brainSpacing';
import { usePanZoom, type FitBox } from './usePanZoom';

// The brain knowledge-graph renderer, ported from nff-dashboard's
// BrainGraph.tsx. Pure SVG; node x/y are board coordinates; a minimum-spacing
// pass keeps overlapping nodes readable; grab-to-pan / scroll-to-zoom. The only
// change from the dashboard: literal monochrome colors became VS Code theme
// variables (--nb-*), so the look inverts correctly in dark themes.

const CATEGORY_ICON = { core: '◈', analysis: '⊕', rules: '▦', strategy: '↑' } as const;

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

export interface BrainGraphHandle {
  resetView: () => void;
}

interface BrainGraphProps {
  nodes: ViewNode[];
  edges: ViewEdge[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  emptyState?: React.ReactNode;
}

export const BrainGraph = forwardRef<BrainGraphHandle, BrainGraphProps>(function BrainGraph(
  { nodes, edges, selectedId, hoveredId, onSelect, onHover, emptyState },
  ref,
) {
  // The central hub is pinned during spacing so the graph keeps its anchor.
  const coreId = useMemo(() => nodes.find((n) => n.category === 'core')?.id ?? null, [nodes]);

  // Minimum-spacing pass, memoized on the node SET (ids + positions + sizes) so
  // live updates never re-jitter the layout.
  const spaceKey = useMemo(
    () => nodes.map((n) => `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${n.size}`).join('|'),
    [nodes],
  );
  const laidOut = useMemo(
    () => spaceOutNodes(nodes, { minGap: 60, pinnedId: coreId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceKey, coreId],
  );

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

  // Re-arm the one-shot auto-fit only when the node-id set changes (add /
  // remove / merge), not on every position tweak.
  const fitKey = useMemo(() => nodes.map((n) => n.id).sort().join(','), [nodes]);

  const { view, panning, svgRef, movedRef, startPan, resetView } = usePanZoom({
    fit,
    fitKey,
    padding: 56,
    minScale: 0.15,
    maxScale: 2.5,
  });

  useImperativeHandle(ref, () => ({ resetView }), [resetView]);

  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, laidOut[n.id]]));

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
          return (
            <g key={i}>
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
        {nodes.map((node) => {
          const p = nodeMap[node.id];
          if (!p) return null;
          const isSelected = node.id === selectedId;
          const isHovered = node.id === hoveredId && !isSelected;
          return (
            <g
              key={node.id}
              style={{ cursor: 'pointer' }}
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
                {CATEGORY_ICON[node.category]}
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
