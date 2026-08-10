import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtToWeb, ViewEdge, ViewNode, WebToExt } from '../src/protocol';
import { BrainGraph, type BrainGraphHandle } from './BrainGraph';

// The Brain tab, ported from nff-dashboard/src/components/BrainTab.tsx: graph
// on the left, "Memory Document" on the right, resizable split. Additions for
// the local tool: node editing (inline form), delete, edge reinforce steppers,
// link/unlink, create node — all routed through the extension host, which owns
// the file. Narrow containers (the activity-bar side view) collapse into the
// dashboard's mobile two-button toggle.

interface VsCodeApi {
  postMessage(msg: WebToExt): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const CATEGORIES = ['core', 'analysis', 'rules', 'strategy'] as const;

interface Draft {
  mode: 'edit' | 'create';
  id: string; // '' when creating
  title: string;
  category: ViewNode['category'];
  content: string;
}

export function App() {
  const [nodes, setNodes] = useState<ViewNode[]>([]);
  const [edges, setEdges] = useState<ViewEdge[]>([]);
  const [projectName, setProjectName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [splitPct, setSplitPct] = useState(62);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'graph' | 'document'>('graph');
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<BrainGraphHandle>(null);
  const didAutoSelect = useRef(false);
  const noticeTimer = useRef<number | null>(null);

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
      }
    }
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Collapse to the stacked two-button layout in narrow containers (side view).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.getBoundingClientRect().width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // On first load, default-select the hub (else the most-connected node).
  useEffect(() => {
    if (didAutoSelect.current || selectedId || nodes.length === 0) return;
    const hub =
      nodes.find((n) => n.category === 'core') ??
      [...nodes].sort((a, b) => b.relatedIds.length - a.relatedIds.length)[0];
    if (hub) {
      setSelectedId(hub.id);
      didAutoSelect.current = true;
    }
  }, [nodes, selectedId]);

  // A deleted/merged-away selection falls back cleanly.
  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
    if (draft?.mode === 'edit' && !nodes.some((n) => n.id === draft.id)) setDraft(null);
  }, [nodes, selectedId, draft]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedEdges = useMemo(
    () => (selectedId ? edges.filter((e) => e.from === selectedId || e.to === selectedId) : []),
    [edges, selectedId],
  );

  const graphPanel = (
    <BrainGraph
      ref={graphRef}
      nodes={nodes}
      edges={edges}
      selectedId={selectedId}
      hoveredId={hoveredId}
      onSelect={setSelectedId}
      onHover={setHoveredId}
      emptyState={
        <div style={{ fontSize: 12, color: 'var(--nb-faint)', textAlign: 'center', lineHeight: 2 }}>
          The brain is empty.
          <br />
          Run <b>nff-brain init</b> in this workspace to seed it from CLAUDE.md / AGENTS.md.
        </div>
      }
    />
  );

  const graphHeader = (
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
        {!narrow && <span style={{ fontSize: 10, color: 'var(--nb-muted)' }}>grab to pan · scroll to zoom</span>}
        <button className="nb-btn" onClick={() => graphRef.current?.resetView()} title="Fit the whole graph to the panel">
          ⤢ Fit
        </button>
        <button
          className="nb-btn"
          onClick={() => setDraft({ mode: 'create', id: '', title: '', category: 'rules', content: '' })}
          title="Add a new knowledge node"
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
  );

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(75, Math.max(30, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── document panel ──────────────────────────────────────────────────────────
  const editForm = draft && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--nb-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
        {draft.mode === 'create' ? 'New node' : `Editing ${draft.id}`}
      </div>
      <input
        className="nb-input"
        placeholder="Title"
        value={draft.title}
        maxLength={80}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <select
        className="nb-select"
        value={draft.category}
        onChange={(e) => setDraft({ ...draft, category: e.target.value as ViewNode['category'] })}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <textarea
        className="nb-textarea"
        placeholder='Actionable knowledge — "When X, do Y because Z"'
        value={draft.content}
        maxLength={1200}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="nb-btn nb-btn--solid"
          disabled={!draft.title.trim() || !draft.content.trim()}
          onClick={() => {
            if (draft.mode === 'create') {
              vscode.postMessage({
                type: 'createNode',
                title: draft.title.trim(),
                category: draft.category,
                content: draft.content.trim(),
              });
            } else {
              vscode.postMessage({
                type: 'editNode',
                id: draft.id,
                title: draft.title.trim(),
                category: draft.category,
                content: draft.content.trim(),
              });
            }
            setDraft(null);
          }}
        >
          Save
        </button>
        <button className="nb-btn" onClick={() => setDraft(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const documentPanel = (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--nb-paper)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--nb-mono)',
        color: 'var(--nb-ink)',
      }}
    >
      <div
        style={{
          padding: '9px 16px',
          borderBottom: '1px solid var(--nb-ink)',
          fontSize: 11,
          letterSpacing: 1,
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        Memory Document
      </div>
      {draft ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>{editForm}</div>
      ) : selectedNode ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          <div style={{ fontSize: 10, color: 'var(--nb-muted)', marginBottom: 10, letterSpacing: 0.5 }}>
            {selectedNode.category.toUpperCase()} &nbsp;·&nbsp; Updated {formatRelativeTime(selectedNode.lastUpdated)}
            &nbsp;·&nbsp; {selectedNode.origin === 'seed' ? 'curated' : 'learned'}
            {selectedNode.source === 'global' ? ' · global' : ''}
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 'bold',
              marginBottom: 14,
              paddingBottom: 14,
              borderBottom: '1px solid var(--nb-ink)',
              lineHeight: 1.3,
            }}
          >
            {selectedNode.title}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.8 }}>
            {selectedNode.content.split('\n\n').map((para, i) => (
              <p key={i} style={{ marginTop: 0, marginBottom: 14 }}>
                {para}
              </p>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              className="nb-btn"
              onClick={() =>
                setDraft({
                  mode: 'edit',
                  id: selectedNode.id,
                  title: selectedNode.title,
                  category: selectedNode.category,
                  content: selectedNode.content,
                })
              }
            >
              ✎ Edit
            </button>
            <button className="nb-btn" onClick={() => vscode.postMessage({ type: 'deleteNode', id: selectedNode.id })}>
              ✕ Delete
            </button>
          </div>

          <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--nb-line)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--nb-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
                Links
              </span>
              <button
                className="nb-icon-btn"
                title="Link this node to another"
                onClick={() => vscode.postMessage({ type: 'addEdgeRequest', from: selectedNode.id })}
              >
                ＋ link
              </button>
            </div>
            {selectedEdges.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--nb-faint)' }}>No links yet.</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {selectedEdges.map((e) => {
                const otherId = e.from === selectedNode.id ? e.to : e.from;
                const other = nodeMap[otherId];
                if (!other) return null;
                return (
                  <div key={otherId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button className="nb-link" style={{ flex: 1, minWidth: 0 }} onClick={() => setSelectedId(otherId)}>
                      {other.title}
                    </button>
                    <span style={{ fontSize: 10, color: 'var(--nb-muted)', width: 32, textAlign: 'right' }}>
                      {e.strength.toFixed(2)}
                    </span>
                    <button
                      className="nb-icon-btn"
                      title="Weaken this link"
                      onClick={() => vscode.postMessage({ type: 'reinforce', from: e.from, to: e.to, delta: -0.1 })}
                    >
                      −
                    </button>
                    <button
                      className="nb-icon-btn"
                      title="Reinforce this link"
                      onClick={() => vscode.postMessage({ type: 'reinforce', from: e.from, to: e.to, delta: 0.1 })}
                    >
                      ＋
                    </button>
                    <button
                      className="nb-icon-btn"
                      title="Remove this link"
                      onClick={() => vscode.postMessage({ type: 'removeEdge', from: e.from, to: e.to })}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: 'var(--nb-faint)',
          }}
        >
          Select a node to view its memory document
        </div>
      )}
    </div>
  );

  // ── layout ──────────────────────────────────────────────────────────────────
  if (narrow) {
    const btnStyle = (active: boolean, last?: boolean): React.CSSProperties => ({
      flex: 1,
      padding: '6px 0',
      fontSize: 12,
      fontFamily: 'var(--nb-mono)',
      border: 'none',
      borderRight: last ? 'none' : '1px solid var(--nb-ink)',
      background: active ? 'var(--nb-ink)' : 'var(--nb-paper)',
      color: active ? 'var(--nb-paper)' : 'var(--nb-ink)',
      cursor: 'pointer',
    });
    return (
      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid var(--nb-ink)' }}>
          <button onClick={() => setMobilePanel('graph')} style={btnStyle(mobilePanel === 'graph')}>
            ◉ Graph
          </button>
          <button onClick={() => setMobilePanel('document')} style={btnStyle(mobilePanel === 'document', true)}>
            ▦ Document
          </button>
        </div>
        <div
          style={{
            display: mobilePanel === 'graph' ? 'flex' : 'none',
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
            background: 'var(--nb-paper)',
          }}
        >
          {graphHeader}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{graphPanel}</div>
        </div>
        <div
          style={{
            display: mobilePanel === 'document' ? 'flex' : 'none',
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {documentPanel}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ display: 'flex', height: '100%', userSelect: dragging ? 'none' : 'auto' }}>
      {/* Left: graph */}
      <div
        style={{
          width: `${splitPct}%`,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--nb-paper)',
          borderRight: '1px solid var(--nb-ink)',
        }}
      >
        {graphHeader}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{graphPanel}</div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        style={{ width: 4, flexShrink: 0, background: 'var(--nb-line)', cursor: 'col-resize' }}
      />

      {/* Right: document panel */}
      {documentPanel}
    </div>
  );
}
