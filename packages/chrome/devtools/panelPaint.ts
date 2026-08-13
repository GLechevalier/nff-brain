// Pure DOM renderers for the Brain panel — no chrome.*, same separation as
// popup/paint.ts. Every piece of node text goes through textContent, never
// innerHTML: brain content is data, not markup.

import type { ActionRecord, ChatSource, GraphEdge, GraphNode, McpServerSummary, McpToolDef, NodesResponse, PlanStep, PublicState, WebAgentRun } from '../src/protocol.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function paintHeader(nodes: NodesResponse | null, connected: boolean): void {
  const dot = $('dot');
  dot.classList.toggle('connected', connected);
  dot.classList.toggle('disconnected', !connected);
  $('disconnected').classList.toggle('hidden', connected);
  if (!nodes) return;
  $('workspace').textContent = nodes.workspace.name;
  $('counts').textContent =
    `${nodes.merged.nodes} nodes (${nodes.workspace.nodes} project · ${nodes.global.nodes} global)`;
  $('updated').textContent = nodes.updatedAt ? `updated ${nodes.updatedAt.slice(0, 16).replace('T', ' ')}` : '';
}

export type PanelTab = 'brain' | 'mcp' | 'graph';

export function switchTab(tab: PanelTab): void {
  $('tab-brain').classList.toggle('active', tab === 'brain');
  $('tab-mcp').classList.toggle('active', tab === 'mcp');
  $('tab-graph').classList.toggle('active', tab === 'graph');
  $('brain-view').classList.toggle('hidden', tab !== 'brain');
  $('mcp-view').classList.toggle('hidden', tab !== 'mcp');
  $('graph-view').classList.toggle('hidden', tab !== 'graph');
}

export type ChatMode = 'manual' | 'plan' | 'auto';

const MODE_HINT: Record<ChatMode, string> = {
  manual: 'Chat answers from your notes. A "navigate to X" request still asks for confirmation first.',
  plan: 'Type a goal. A plan is generated and shown for your approval before anything runs. A "navigate to X" request still asks first.',
  auto: 'Type a goal. The plan is approved automatically the moment it is ready — no review step. A "navigate to X" request opens immediately too, no asking.',
};

export function paintMode(mode: ChatMode): void {
  for (const m of ['manual', 'plan', 'auto'] as const) {
    $(`mode-${m}`).classList.toggle('active', m === mode);
  }
  $('mode-hint').textContent = MODE_HINT[mode];
  $('goal-options').classList.toggle('hidden', mode === 'manual');
  ($('prompt-input') as HTMLTextAreaElement).placeholder =
    mode === 'manual' ? 'Ask your brain — e.g. what did I learn about OAuth callbacks' : 'Describe a goal…';
}

// ── LinkedIn agent adapter toggle (always visible, not mode-gated) ──────────

export function paintAdapter(state: PublicState): void {
  const linkedin = state.agentAdapters.find((a) => a.id === 'linkedin');
  const btn = $('adapter-toggle') as HTMLButtonElement;
  if (!linkedin) {
    btn.disabled = true;
    return;
  }
  btn.textContent = linkedin.enabled ? 'Disable' : 'Enable';
  btn.title = linkedin.enabled
    ? `Stop the agent acting on ${linkedin.hosts.join(', ')}`
    : `Ask Chrome for ${linkedin.hosts.join(', ')}`;
}

// ── the transcript — one unified log, entries typed and rendered differently ─

const AGENT_PHASE_TEXT: Record<WebAgentRun['phase'], string> = {
  planning: 'Planning…',
  awaiting_approval: 'Plan ready — review below',
  running: 'Running',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  done: 'Done',
  error: 'Error',
};

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'answer'; text: string; sources: ChatSource[] }
  | { kind: 'plan'; runId: string; run: WebAgentRun }
  | { kind: 'run'; runId: string; run: WebAgentRun }
  | { kind: 'pending'; word: string }
  // Manual-mode chat's action-intent permission prompt. Unresolved (no
  // `decision`) shows Yes/No/Never-ask buttons; resolved shows a status line
  // instead — same "mutate this entry in place" discipline as plan → run.
  // target distinguishes a registered adapter (real DOM automation may sit
  // behind it) from a generic host guess (actionIntent.ts's fallback) — the
  // rendering below is target-agnostic (URL/label only); only panel.ts's
  // resolution logic needs to branch on it.
  | {
      kind: 'permission';
      requestId: string;
      target: { kind: 'adapter'; adapterId: string } | { kind: 'host'; host: string };
      label: string;
      url: string;
      decision?: 'yes' | 'no' | 'always';
    };

export interface TranscriptHandlers {
  onApprovePlan: (runId: string) => void;
  onDiscardPlan: (runId: string) => void;
  onStopRun: (runId: string) => void;
  onPermissionDecision: (requestId: string, decision: 'yes' | 'no' | 'always') => void;
}

function userEntryEl(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-user';
  div.textContent = text;
  return div;
}

function sourceChip(s: ChatSource): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = s.title;
  return chip;
}

function answerEntryEl(text: string, sources: readonly ChatSource[]): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-answer';
  const p = document.createElement('div');
  p.className = 'answer-text';
  p.textContent = text;
  div.append(p);
  if (sources.length > 0) {
    const src = document.createElement('div');
    src.className = 'entry-sources small muted';
    src.append(document.createTextNode('from: '), ...sources.map(sourceChip));
    div.append(src);
  }
  return div;
}

function pendingEntryEl(word: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-pending';
  const span = document.createElement('span');
  span.className = 'pending-word';
  span.textContent = word;
  div.append(span);
  return div;
}

function planStepLine(step: PlanStep, index: number): HTMLLIElement {
  const li = document.createElement('li');
  const summary = document.createElement('span');
  summary.textContent = `${index + 1}. ${step.summary}`;
  li.append(summary);
  return li;
}

function planEntryEl(run: WebAgentRun, handlers: TranscriptHandlers): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-plan';

  const title = document.createElement('div');
  title.className = 'strong small';
  title.textContent = 'Plan ready — review before it runs';
  div.append(title);

  const plan = run.plan;
  const summary = document.createElement('p');
  summary.className = 'small';
  summary.textContent = plan ? `Up to ${plan.maxActions} connect(s). Criteria: ${plan.criteria || '(none stated)'}` : '';
  div.append(summary);

  const steps = document.createElement('ol');
  steps.className = 'list';
  steps.append(...(plan?.steps.map(planStepLine) ?? []));
  div.append(steps);

  const row = document.createElement('div');
  row.className = 'row gap';
  const approve = document.createElement('button');
  approve.className = 'btn primary';
  approve.textContent = 'Approve & run';
  approve.addEventListener('click', () => handlers.onApprovePlan(run.id));
  const discard = document.createElement('button');
  discard.className = 'btn';
  discard.textContent = 'Discard';
  discard.addEventListener('click', () => handlers.onDiscardPlan(run.id));
  row.append(approve, discard);
  div.append(row);

  return div;
}

const PERMISSION_RESOLVED_TEXT: Record<'yes' | 'no' | 'always', string> = {
  yes: 'Opened.',
  no: 'Declined.',
  always: 'Always allowed — opened.',
};

function permissionEntryEl(
  entry: Extract<TranscriptEntry, { kind: 'permission' }>,
  handlers: TranscriptHandlers,
): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-permission';

  const title = document.createElement('div');
  title.className = 'strong small';
  title.textContent = `Navigate to "${entry.url}"?`;
  div.append(title);

  if (entry.decision) {
    const status = document.createElement('p');
    status.className = 'small';
    status.textContent = PERMISSION_RESOLVED_TEXT[entry.decision];
    div.append(status);
    return div;
  }

  const row = document.createElement('div');
  row.className = 'row gap';
  const yes = document.createElement('button');
  yes.className = 'btn primary';
  yes.textContent = 'Yes';
  yes.addEventListener('click', () => handlers.onPermissionDecision(entry.requestId, 'yes'));
  const no = document.createElement('button');
  no.className = 'btn';
  no.textContent = 'No';
  no.addEventListener('click', () => handlers.onPermissionDecision(entry.requestId, 'no'));
  const always = document.createElement('button');
  always.className = 'btn';
  always.textContent = 'Never ask again';
  always.addEventListener('click', () => handlers.onPermissionDecision(entry.requestId, 'always'));
  row.append(yes, no, always);
  div.append(row);

  return div;
}

function historyLine(record: ActionRecord): HTMLLIElement {
  const li = document.createElement('li');
  const summary = document.createElement('span');
  const ok = record.result?.ok;
  const mark = ok === undefined ? '…' : ok ? '✓' : '✗';
  summary.textContent = `${mark} ${record.verb} — ${record.result?.summary ?? '(pending)'}`;
  const when = document.createElement('span');
  when.className = 'muted small';
  when.textContent = new Date(record.requestedAt).toLocaleTimeString();
  li.append(summary, when);
  if (record.result?.listWriteError) {
    const warn = document.createElement('span');
    warn.className = 'error small';
    warn.textContent = `list write failed: ${record.result.listWriteError}`;
    li.append(warn);
  }
  return li;
}

function runEntryEl(run: WebAgentRun, handlers: TranscriptHandlers): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'entry entry-run';

  const head = document.createElement('div');
  head.className = 'row';
  const phase = document.createElement('span');
  phase.className = 'strong small';
  phase.textContent = AGENT_PHASE_TEXT[run.phase];
  const progress = document.createElement('span');
  progress.className = 'muted small push';
  progress.textContent = `${run.actionsTaken}/${run.maxActions} connected`;
  head.append(phase, progress);
  div.append(head);

  if (run.error) {
    const err = document.createElement('div');
    err.className = 'small error';
    err.textContent = run.error;
    div.append(err);
  }

  const history = document.createElement('ol');
  history.className = 'list';
  history.append(...[...run.history].reverse().map(historyLine));
  div.append(history);

  if (run.phase === 'running' || run.phase === 'stopping') {
    const stop = document.createElement('button');
    stop.className = 'btn danger wide';
    stop.textContent = 'Stop';
    stop.disabled = run.phase === 'stopping';
    stop.addEventListener('click', () => handlers.onStopRun(run.id));
    div.append(stop);
  }

  return div;
}

function entryEl(entry: TranscriptEntry, handlers: TranscriptHandlers): HTMLElement {
  switch (entry.kind) {
    case 'user':
      return userEntryEl(entry.text);
    case 'answer':
      return answerEntryEl(entry.text, entry.sources);
    case 'plan':
      return planEntryEl(entry.run, handlers);
    case 'run':
      return runEntryEl(entry.run, handlers);
    case 'pending':
      return pendingEntryEl(entry.word);
    case 'permission':
      return permissionEntryEl(entry, handlers);
  }
}

/** Full rebuild, same "replaceChildren" discipline as every other list in this panel. */
export function renderTranscript(entries: readonly TranscriptEntry[], handlers: TranscriptHandlers): void {
  const el = $('transcript');
  el.replaceChildren(...entries.map((e) => entryEl(e, handlers)));
  el.scrollTop = el.scrollHeight;
}

// ── goal-options selects (Plan/Auto mode's "add matches to") ────────────────

export function paintMcpServerOptions(servers: McpServerSummary[], selected: string | null): void {
  const select = $('list-server') as HTMLSelectElement;
  select.replaceChildren(
    ...[{ id: '', name: '(none — skip the list step)', enabled: true }, ...servers].map((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.enabled ? s.name : `${s.name} (disabled)`;
      opt.disabled = s.id !== '' && !s.enabled;
      return opt;
    }),
  );
  if (selected !== null) select.value = selected;
}

export function paintMcpToolOptions(tools: McpToolDef[], selected: string | null): void {
  const select = $('list-tool') as HTMLSelectElement;
  select.disabled = tools.length === 0;
  select.replaceChildren(
    ...tools.map((t) => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.description ? `${t.name} — ${t.description}` : t.name;
      return opt;
    }),
  );
  if (selected !== null) select.value = selected;
}

// ── the MCP tab's server list ────────────────────────────────────────────────

export interface McpListItem extends McpServerSummary {
  /** null = not tested yet this session. */
  toolCount: number | null;
}

export interface McpListHandlers {
  onTest: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}

export function renderMcpList(servers: readonly McpListItem[], handlers: McpListHandlers): void {
  $('mcp-empty').classList.toggle('hidden', servers.length > 0);
  $('mcp-list').replaceChildren(
    ...servers.map((s) => {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = `mcp-dot${s.enabled ? ' enabled' : ''}`;
      const name = document.createElement('span');
      name.className = 'mcp-name';
      name.textContent = s.name;
      const info = document.createElement('span');
      info.className = 'muted small';
      info.textContent = s.toolCount === null ? '' : `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`;

      const actions = document.createElement('span');
      actions.className = 'mcp-actions';
      const test = document.createElement('button');
      test.className = 'btn small';
      test.textContent = 'Test';
      test.addEventListener('click', () => handlers.onTest(s.id));
      const toggle = document.createElement('button');
      toggle.className = 'btn small';
      toggle.textContent = s.enabled ? 'Disable' : 'Enable';
      toggle.addEventListener('click', () => handlers.onToggleEnabled(s.id, !s.enabled));
      const remove = document.createElement('button');
      remove.className = 'btn small danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => handlers.onRemove(s.id));
      actions.append(test, toggle, remove);

      li.append(dot, name, info, actions);
      return li;
    }),
  );
}

// ── Graph tab — reads geometry the CLI already computed, never lays out itself ─

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_LABEL_MAX = 24;

export interface GraphViewBox { x: number; y: number; w: number; h: number; }

export interface GraphHandlers {
  /** A node's circle was pressed — the caller decides whether that starts a drag. */
  onNodeMouseDown: (id: string, e: MouseEvent) => void;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function truncateLabel(title: string): string {
  return title.length > GRAPH_LABEL_MAX ? `${title.slice(0, GRAPH_LABEL_MAX - 1)}…` : title;
}

// Rebuilt fresh by every renderGraph call, read by setNodePosition — the
// element identities a drag needs to move WITHOUT rebuilding the whole SVG.
interface GraphNodeEls {
  circle: SVGCircleElement;
  label: SVGTextElement;
  size: number;
  edgeEnds: Array<{ line: SVGLineElement; end: 'x1y1' | 'x2y2' }>;
}
const graphNodeEls = new Map<string, GraphNodeEls>();

/**
 * Rebuilds the graph SVG from scratch and returns a fitted view box (node
 * bounding box + padding) for the caller to hand to setGraphViewBox. Pan/zoom
 * afterwards must go through setGraphViewBox, and a node drag through
 * setNodePosition — neither ever calls renderGraph again mid-gesture, only on
 * the next poll or tab entry, which always rebuilds every node/edge element.
 */
export function renderGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[], handlers: GraphHandlers): GraphViewBox {
  const host = $('graph-canvas');
  const svg = svgEl('svg');
  graphNodeEls.clear();

  if (nodes.length === 0) {
    const box: GraphViewBox = { x: 0, y: 0, w: 400, h: 200 };
    const text = svgEl('text');
    text.setAttribute('class', 'graph-empty');
    text.setAttribute('x', '50%');
    text.setAttribute('y', '50%');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = 'No nodes yet';
    svg.append(text);
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    host.replaceChildren(svg);
    return box;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.size);
    minY = Math.min(minY, n.y - n.size);
    maxX = Math.max(maxX, n.x + n.size);
    maxY = Math.max(maxY, n.y + n.size);
  }
  const pad = 40;
  const box: GraphViewBox = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };

  // Lines whose endpoint touches a given node id — setNodePosition re-anchors
  // these during a drag so a node's connections never visually detach from it.
  const edgeEndsByNode = new Map<string, Array<{ line: SVGLineElement; end: 'x1y1' | 'x2y2' }>>();
  const edgeGroup = svgEl('g');
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const line = svgEl('line');
    line.setAttribute('class', 'graph-edge');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-opacity', String(Math.min(1, Math.max(0.08, e.strength))));
    edgeGroup.append(line);
    (edgeEndsByNode.get(e.from) ?? edgeEndsByNode.set(e.from, []).get(e.from)!).push({ line, end: 'x1y1' });
    (edgeEndsByNode.get(e.to) ?? edgeEndsByNode.set(e.to, []).get(e.to)!).push({ line, end: 'x2y2' });
  }
  svg.append(edgeGroup);

  const nodeGroup = svgEl('g');
  for (const n of nodes) {
    const circle = svgEl('circle');
    circle.setAttribute('class', 'graph-node');
    circle.setAttribute('cx', String(n.x));
    circle.setAttribute('cy', String(n.y));
    circle.setAttribute('r', String(n.size));
    circle.setAttribute('fill', n.color);
    circle.addEventListener('mousedown', (e) => {
      e.stopPropagation(); // a node drag must never also start a canvas pan
      handlers.onNodeMouseDown(n.id, e);
    });
    const title = svgEl('title');
    title.textContent = n.title;
    circle.append(title);
    nodeGroup.append(circle);

    const label = svgEl('text');
    label.setAttribute('class', 'graph-label');
    label.setAttribute('x', String(n.x));
    label.setAttribute('y', String(n.y + n.size + 7));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = truncateLabel(n.title);
    nodeGroup.append(label);

    graphNodeEls.set(n.id, {
      circle,
      label,
      size: n.size,
      edgeEnds: edgeEndsByNode.get(n.id) ?? [],
    });
  }
  svg.append(nodeGroup);

  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  host.replaceChildren(svg);
  return box;
}

/** Cheap — only touches the existing <svg>'s viewBox, never rebuilds nodes/edges. */
export function setGraphViewBox(box: GraphViewBox): void {
  const svg = $('graph-canvas').querySelector('svg');
  if (!svg) return;
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
}

/**
 * Cheap — moves one node's circle, label and touching edge-ends during a
 * drag, never rebuilds the SVG. Elements come from the last renderGraph call;
 * a stale/unknown id (deleted mid-drag) is a silent no-op.
 */
export function setNodePosition(id: string, x: number, y: number): void {
  const els = graphNodeEls.get(id);
  if (!els) return;
  els.circle.setAttribute('cx', String(x));
  els.circle.setAttribute('cy', String(y));
  els.label.setAttribute('x', String(x));
  els.label.setAttribute('y', String(y + els.size + 7));
  for (const { line, end } of els.edgeEnds) {
    if (end === 'x1y1') {
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(y));
    } else {
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(y));
    }
  }
}

export function showFieldError(id: string, message: string | null): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('hidden', !message);
}
