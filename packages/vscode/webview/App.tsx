import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Subpath imports on purpose: the core barrel pulls node:fs/node:child_process
// and would break the browser (webview) bundle. score.ts / rank.ts / vector.ts
// are the dependency-free trio — the webview may import those three and
// nothing else from core (enforced by webviewImports.test.ts).
import { fuseRanked } from '@nff-brain/core/rank';
import type { ExtToWeb, ViewNode, WebToExt } from '../src/protocol';
import { BrainGraph, type BrainGraphHandle } from './BrainGraph';
import { useActivityGlow } from './useActivityGlow';
import { useSemanticSearch } from './useSemanticSearch';

// The Brain graph, ported from nff-dashboard's BrainTab. The old in-webview
// "Memory Document" panel is gone: clicking a node asks the extension host to
// open that node as a REAL markdown editor tab beside the graph (nffbrain:
// virtual filesystem) — read it, edit it, save it back, all native VS Code.

interface VsCodeApi {
  postMessage(msg: WebToExt): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function App() {
  const [nodes, setNodes] = useState<ViewNode[]>([]);
  const [edges, setEdges] = useState<{ from: string; to: string; strength: number }[]>([]);
  const [projectName, setProjectName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<BrainGraphHandle>(null);
  const noticeTimer = useRef<number | null>(null);
  // Signature of the last batch of positions we asked the host to persist.
  // Persisting writes brain.json, which the host watches, which rebroadcasts
  // the graph — so without this guard a single new node would ping-pong. The
  // rebroadcast carries laidOut: true, so the layout stops reporting it and the
  // loop ends after one round-trip; this ref catches any duplicate in between.
  const lastPersisted = useRef<string>('');

  // Living-graph heat: which nodes the agent recently looked at, and how hot.
  const { glow, visible, onActivity } = useActivityGlow(nodes);

  // Semantic half of the search box. Stable identity so the hook's debounce
  // effect doesn't re-fire on every render.
  const postToHost = useCallback((msg: WebToExt) => vscode.postMessage(msg), []);
  const semantic = useSemanticSearch({ query, post: postToHost });

  // ── extension bridge ────────────────────────────────────────────────────────
  useEffect(() => {
    function onMessage(ev: MessageEvent<ExtToWeb>) {
      const msg = ev.data;
      if (msg.type === 'graph') {
        setNodes(msg.nodes);
        setEdges(msg.edges);
        setProjectName(msg.projectName);
      } else if (msg.type === 'notice') {
        setNotice(msg.text);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
      } else if (msg.type === 'busy') {
        setBusy(msg.on);
      } else if (msg.type === 'activity') {
        onActivity(msg.events, msg.replay === true);
      } else {
        semantic.onMessage(msg); // vectors / queryVector
      }
    }
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [onActivity, semantic.onMessage]);

  // Persist positions the layout settled for nodes that had none.
  const onLayout = useCallback((positions: Array<{ id: string; x: number; y: number }>) => {
    if (positions.length === 0) return;
    const sig = positions
      .map((p) => `${p.id}:${Math.round(p.x)}:${Math.round(p.y)}`)
      .sort()
      .join('|');
    if (sig === lastPersisted.current) return;
    lastPersisted.current = sig;
    vscode.postMessage({ type: 'layout', positions });
  }, []);

  // Hide the pan/zoom hint when the panel gets cramped.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A deleted/merged-away selection falls back cleanly.
  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [nodes, selectedId]);

  // +/-/0 zoom keys. Two guards, both load-bearing: skip while a text field has
  // focus (typing '-' in the search box must not zoom the graph), and skip when
  // ctrl/meta is held — Ctrl+= belongs to VS Code's own window zoom.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '+' || e.key === '=') graphRef.current?.zoomBy(1.25);
      else if (e.key === '-' || e.key === '_') graphRef.current?.zoomBy(1 / 1.25);
      else if (e.key === '0') graphRef.current?.resetView();
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── node search ─────────────────────────────────────────────────────────────
  // Lexical ranks SYNCHRONOUSLY on every keystroke; semantic.hits is null until
  // the host answers with a query vector for this exact text, at which point
  // the order refines. So the box is never slower than it used to be, and a
  // missing/broken/disabled model is indistinguishable from the old behaviour.
  const matches = useMemo(
    () => fuseRanked(query, nodes, semantic.hits).map((r) => r.node),
    [nodes, query, semantic.hits],
  );
  const matchedIds = useMemo(
    () => (query.trim() ? new Set(matches.map((n) => n.id)) : null),
    [matches, query],
  );

  function openNode(id: string) {
    setSelectedId(id);
    vscode.postMessage({ type: 'openNode', id }); // → native .md tab beside the graph
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter' || matches.length === 0) return;
    const i = matches.findIndex((n) => n.id === selectedId);
    const next = matches[(i + 1) % matches.length];
    openNode(next.id);
    graphRef.current?.focusNode(next.id);
  }

  return (
    <div
      ref={containerRef}
      className={visible ? undefined : 'nb-anim-off'}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--nb-paper)' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--nb-ink)',
          flexShrink: 0,
          background: 'var(--nb-paper)',
          fontFamily: 'var(--nb-mono)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--nb-ink)' }}>
          Brain{projectName ? ` · ${projectName}` : ''} · {nodes.length} node{nodes.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {notice && <span style={{ fontSize: 11, color: 'var(--nb-muted)' }}>{notice}</span>}
          {!narrow && (
            <span style={{ fontSize: 10, color: 'var(--nb-muted)' }}>
              click a node to open its .md · grab to pan · scroll to zoom · +/−/0
            </span>
          )}
          <input
            className="nb-input"
            placeholder="search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            title="Search nodes — Enter opens (and cycles through) matches, Esc clears"
            style={{ width: 140, fontSize: 11, padding: '3px 6px' }}
          />
          {query.trim() && (
            <span style={{ fontSize: 10, color: 'var(--nb-muted)' }}>
              {matches.length} hit{matches.length === 1 ? '' : 's'}
            </span>
          )}
          {/* Zoom cluster. The readout is fixed-width so stepping through
              levels doesn't shuffle the buttons sideways. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                fontSize: 10,
                color: 'var(--nb-muted)',
                minWidth: 34,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
              title="Current zoom level"
            >
              {Math.round(scale * 100)}%
            </span>
            <button
              className="nb-icon-btn"
              onClick={() => graphRef.current?.zoomBy(1 / 1.25)}
              title="Zoom out (−)"
            >
              −
            </button>
            <button className="nb-icon-btn" onClick={() => graphRef.current?.zoomBy(1.25)} title="Zoom in (+)">
              ＋
            </button>
          </div>
          <button
            className="nb-btn"
            onClick={() => graphRef.current?.resetView()}
            title="Fit the whole graph to the panel (0)"
          >
            ⤢ Fit
          </button>
          <button
            className="nb-btn"
            onClick={() => vscode.postMessage({ type: 'createNodeRequest' })}
            title="Add a new knowledge node (opens its .md for editing)"
          >
            ＋ Node
          </button>
          <button
            className="nb-btn nb-btn--solid"
            onClick={() => vscode.postMessage({ type: 'merge' })}
            disabled={busy || nodes.length === 0}
            title="Merge the least-used learned nodes into their nearest neighbours (nothing is deleted)"
          >
            {busy ? 'Merging…' : '⤵ Merge'}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <BrainGraph
          ref={graphRef}
          nodes={nodes}
          edges={edges}
          selectedId={selectedId}
          hoveredId={hoveredId}
          matchedIds={matchedIds}
          glow={glow}
          onSelect={openNode}
          onHover={setHoveredId}
          onLayout={onLayout}
          onScaleChange={setScale}
          emptyState={
            <div style={{ fontSize: 12, color: 'var(--nb-faint)', textAlign: 'center', lineHeight: 2 }}>
              The brain is empty.
              <br />
              Run <b>nff-brain init</b> in this workspace to seed it from CLAUDE.md / AGENTS.md.
            </div>
          }
        />
      </div>
    </div>
  );
}
