import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activityPath,
  asCategory,
  buildCompanySyncPayload,
  CATEGORIES,
  eventSavings,
  foldLeastUsed,
  layoutBrain,
  loadBrain,
  mergeBrains,
  mutateBrain,
  placeNode,
  readNewActivity,
  readRecentActivity,
  resolveBrainPaths,
  slug,
  upsertNode,
  embedQuery,
  encodeVector,
  loadVectors,
  queryVectors,
  resolveTransformers,
  type ActivityEvent,
  type BrainFile,
  type BrainNode,
  type BrainPaths,
} from '@nff-brain/core';
import { BrainFs, BrainLinkProvider, nodeUri, SCHEME } from './brainFs';
import { BrainLauncherProvider } from './launcherView';
import type { ExtToWeb, NodeSource, ViewActivityEvent, ViewEdge, ViewNode, WebToExt } from './protocol';

// The extension host is the SOLE filesystem authority: every mutation goes
// through core's lock + atomic write, and the webview only renders what it is
// posted. A change on disk (e.g. the SessionEnd hook distilling new nodes while
// the panel is open) round-trips through the watcher back into the webview.

let channelViews: Set<vscode.Webview>;
let paths: BrainPaths;
let out: vscode.OutputChannel;
let brainFs: BrainFs;

function logLine(msg: string): void {
  out?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function loadSafe(p: string): BrainFile | null {
  try {
    return loadBrain(p);
  } catch {
    return null;
  }
}

interface GraphSnapshot {
  nodes: ViewNode[];
  edges: ViewEdge[];
  sourceById: Map<string, NodeSource>;
}

/** The raw merged graph — what the savings estimate is computed from. */
function loadMerged(): ReturnType<typeof mergeBrains> {
  return mergeBrains(loadSafe(paths.project), loadSafe(paths.global));
}

function loadGraph(): GraphSnapshot {
  const merged = loadMerged();
  const related = new Map<string, string[]>();
  for (const e of merged.edges) {
    (related.get(e.from) ?? related.set(e.from, []).get(e.from)!).push(e.to);
    (related.get(e.to) ?? related.set(e.to, []).get(e.to)!).push(e.from);
  }
  const nodes: ViewNode[] = merged.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    category: n.category,
    content: n.content,
    x: n.x,
    y: n.y,
    size: n.size,
    origin: n.origin,
    laidOut: n.laidOut,
    lastUpdated: n.lastUpdated,
    recallCount: n.recallCount ?? 0,
    lastRecalledAt: n.lastRecalledAt,
    confidence: n.confidence,
    private: n.private,
    shared: n.shared,
    source: merged.sourceById.get(n.id) ?? 'project',
    relatedIds: related.get(n.id) ?? [],
  }));
  return { nodes, edges: merged.edges.map((e) => ({ ...e })), sourceById: merged.sourceById };
}

function post(webview: vscode.Webview, msg: ExtToWeb): void {
  void webview.postMessage(msg);
}

function broadcastGraph(): void {
  const graph = loadGraph();
  const projectName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'global';
  for (const w of channelViews) {
    post(w, { type: 'graph', nodes: graph.nodes, edges: graph.edges, projectName });
  }
}

function fileFor(source: NodeSource): string {
  return source === 'project' ? paths.project : paths.global;
}

// ── company brain sync ──────────────────────────────────────────────────────
// Push the merged brain (minus nodes marked private — buildCompanySyncPayload
// is THE shared filter, the Chrome extension uses the same one) to nff-admin's
// employee ingest. The per-employee token lives in SecretStorage; settings
// carry only the toggle + endpoint. Fire-and-forget: a failure surfaces as a
// message (manual) or a log line (auto), and auto retries on the next change.

const SECRET_COMPANY_SYNC_TOKEN = 'nffBrain.companySyncToken';
let extSecrets: vscode.SecretStorage;
let companySyncTokenPresent = false; // mirror for the sync-path + launcher row (secrets.get is async)
let companySyncLastAt = '';
let companySyncTimer: NodeJS.Timeout | null = null;

async function syncToCompany(manual: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('nffBrain');
  const token = await extSecrets.get(SECRET_COMPANY_SYNC_TOKEN);
  if (!token) {
    if (manual) {
      void vscode.window.showErrorMessage(
        'nff-brain: no company sync token — run "nff-brain: Set Company Sync Token…" first (an admin mints it in nff-admin\'s Users tab).',
      );
    }
    return;
  }
  if (!manual && !cfg.get<boolean>('companySync.enabled', false)) return;

  const url = cfg.get<string>('companySync.url', 'https://admin.nanoforgeflow.com/api/tables/brain/ingest');
  const merged = loadMerged();
  const payload = buildCompanySyncPayload(merged);
  // Empty push = full-replace wipe of the server copy. Never what was meant.
  if (payload.nodes.length === 0) {
    const why = merged.nodes.length === 0 ? 'this brain is empty' : 'every node is marked private';
    logLine(`company sync skipped: ${why}`);
    if (manual) void vscode.window.showWarningMessage(`nff-brain: nothing to sync — ${why}.`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-sync-token': token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as { synced?: number };
    companySyncLastAt = new Date().toISOString();
    launcher?.refresh();
    const kept = merged.nodes.length - payload.nodes.length;
    const summary = `synced ${out.synced ?? payload.nodes.length} node(s)${kept > 0 ? ` (${kept} private stayed home)` : ''}`;
    logLine(`company sync: ${summary}`);
    if (manual) void vscode.window.showInformationMessage(`nff-brain: ${summary}.`);
    else vscode.window.setStatusBarMessage(`$(cloud-upload) brain ${summary}`, 5000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(`company sync FAILED: ${msg}`);
    if (manual) void vscode.window.showErrorMessage(`nff-brain: company sync failed — ${msg}`);
  }
}

/** Auto-sync debounce: re-armed on every brain.json change. 45s, so a burst of
 *  edits (or a whole Claude session distilling) lands as one push. */
function scheduleCompanySync(): void {
  if (!companySyncTokenPresent) return;
  if (!vscode.workspace.getConfiguration('nffBrain').get<boolean>('companySync.enabled', false)) return;
  if (companySyncTimer) clearTimeout(companySyncTimer);
  companySyncTimer = setTimeout(() => void syncToCompany(false), 45_000);
}

// ── semantic search ─────────────────────────────────────────────────────────
// The host owns the model (node-only native runtime) and the vector sidecar.
// The webview does pure cosine on vectors we push it, and posts embedQuery for
// each settled keystroke. Everything here is best-effort: if semantic is off,
// broken, or slow, the webview's lexical results simply stand.

function semanticSetting(): 'auto' | 'on' | 'off' {
  const v = vscode.workspace.getConfiguration('nffBrain').get<string>('semanticSearch', 'auto');
  return v === 'on' || v === 'off' ? v : 'auto';
}

/** Auto = on iff the runtime resolves AND a vector index exists. */
function semanticEnabled(): boolean {
  const mode = semanticSetting();
  if (mode === 'off') return false;
  if (!resolveTransformers().installed) return false;
  return mode === 'on' || loadVectors(paths.project) !== null || loadVectors(paths.global) !== null;
}

function pushVectors(webview: vscode.Webview): void {
  try {
    if (!semanticEnabled()) {
      post(webview, { type: 'vectors', enabled: false, dim: 0, entries: [] });
      return;
    }
    const { vectors, dim } = queryVectors(paths);
    // ~2 KB of base64 per node — ~840 KB at the 400-node cap. Fine as a
    // one-shot push; do NOT move this onto broadcastGraph's 150 ms debounce.
    const entries = [...vectors].map(([id, v]) => ({ id, v: encodeVector(v) }));
    post(webview, { type: 'vectors', enabled: entries.length > 0, dim, entries });
    logLine(`semantic: pushed ${entries.length} vector(s), dim ${dim}`);
  } catch (err) {
    post(webview, { type: 'vectors', enabled: false, dim: 0, entries: [] });
    logLine(`semantic: vector push failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pushVectorsAll(): void {
  for (const w of channelViews) pushVectors(w);
}

// ── activity relay: .nff-brain/activity.jsonl → webview glow ─────────────────
// The CLI (recall/novelty/search/expand/distill) appends one line per "the
// agent looked at these nodes" moment; we tail-read new lines by byte offset
// and forward them. Offsets make coalesced watcher fires idempotent; the LRU
// de-dups the rare offset reset after a rotation/truncation.

const ACTIVITY_REPLAY_MS = 12 * 60_000; // matches the glow's ~12 min lifetime
let activityOffset = 0;
const seenActivityKeys: string[] = [];
// Tokens the brain saved since this window opened (the launcher's live "+N this
// session"). Only recall events count — the same ones that bump recallCount —
// so this is exactly the increment of the lifetime figure.
let sessionSaved = 0;
let launcher: BrainLauncherProvider | null = null;

function toViewEvents(events: ActivityEvent[]): ViewActivityEvent[] {
  return events.map((e) => ({ at: e.at, kind: e.kind, ids: e.ids, seedCount: e.seedCount }));
}

function dedupActivity(events: ActivityEvent[]): ActivityEvent[] {
  const fresh: ActivityEvent[] = [];
  for (const e of events) {
    const key = `${e.at}|${e.kind}`;
    if (seenActivityKeys.includes(key)) continue;
    seenActivityKeys.push(key);
    if (seenActivityKeys.length > 64) seenActivityKeys.shift();
    fresh.push(e);
  }
  return fresh;
}

function relayActivity(): void {
  try {
    const { events, nextOffset } = readNewActivity(activityPath(paths.project), activityOffset);
    activityOffset = nextOffset;
    const fresh = dedupActivity(events);
    if (fresh.length === 0) return;
    logLine(`activity: ${fresh.map((e) => `${e.kind}(${e.ids.length})`).join(' ')}`);
    for (const w of channelViews) post(w, { type: 'activity', events: toViewEvents(fresh) });

    // The watcher fires whether or not a panel is open, so the launcher's
    // savings readout keeps ticking with the graph closed.
    const byId = new Map<string, BrainNode>(loadMerged().nodes.map((n) => [n.id, n]));
    const gained = eventSavings(fresh, byId);
    if (gained > 0) {
      sessionSaved += gained;
      launcher?.refresh();
    }
  } catch (err) {
    logLine(`activity relay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The editor group holding the graph webview (falls back to the active group). */
function graphColumn(): vscode.ViewColumn {
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      const input = t.input as { viewType?: string } | undefined;
      // Webview tab viewTypes arrive prefixed (e.g. "mainThreadWebview-nffBrain").
      if (typeof input?.viewType === 'string' && input.viewType.includes('nffBrain')) {
        return g.viewColumn;
      }
    }
  }
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
}

/**
 * Where node documents go: the existing group next to the graph. Only when the
 * graph is the sole group does Beside create a second one — with two or more
 * groups open, docs always land in the neighbour, never a fresh third column.
 */
function docColumn(): vscode.ViewColumn {
  const gc = graphColumn();
  const others = vscode.window.tabGroups.all.map((g) => g.viewColumn).filter((c) => c !== gc);
  if (others.length === 0) return vscode.ViewColumn.Beside;
  const right = others.filter((c) => c > gc).sort((a, b) => a - b)[0];
  return right ?? others.sort((a, b) => a - b)[0];
}

/**
 * Open a node beside the graph — RENDERED markdown preview for reading (node
 * clicks), raw source only when the caller needs the cursor in it (new node).
 */
async function openNodeDoc(source: NodeSource, id: string, opts?: { focus?: boolean }): Promise<void> {
  const uri = nodeUri(source, id);
  if (opts?.focus) {
    await vscode.window.showTextDocument(uri, { viewColumn: docColumn(), preview: false });
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', {
    viewColumn: docColumn(),
    preserveFocus: true,
    preview: true,
  } satisfies vscode.TextDocumentShowOptions);
}

async function handleMessage(msg: WebToExt, webview: vscode.Webview): Promise<void> {
  const graph = loadGraph();
  try {
    switch (msg.type) {
      case 'ready': {
        broadcastGraph();
        pushVectors(webview);
        // A panel opening late still shows what the agent recently looked at,
        // glowing at its decayed intensity (real timestamps, no arrival flash).
        try {
          const recent = readRecentActivity(activityPath(paths.project), ACTIVITY_REPLAY_MS);
          if (recent.length) post(webview, { type: 'activity', events: toViewEvents(recent), replay: true });
        } catch {
          /* replay is best-effort */
        }
        return;
      }

      case 'embedQuery': {
        // Model load is lazy and happens HERE — on the first search keystroke,
        // never at activate(). A warm session is ~100–200 MB RSS in a host
        // shared with every other extension, so we do not pay it for users who
        // never search. Any failure answers null and the webview keeps its
        // lexical ordering.
        let v: string | null = null;
        try {
          if (semanticEnabled()) {
            const vec = await embedQuery(msg.query);
            if (vec) v = encodeVector(vec);
          }
        } catch (err) {
          logLine(`semantic: embedQuery failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        post(webview, { type: 'queryVector', seq: msg.seq, v });
        return;
      }

      case 'openNode': {
        const source = graph.sourceById.get(msg.id);
        if (!source) return;
        await openNodeDoc(source, msg.id);
        return; // read-only action — no graph rebroadcast needed
      }

      case 'layout': {
        // The webview settled positions for nodes that arrived without one.
        // Split by source: the merged graph spans two files and a position must
        // land in the one that actually owns the node.
        const byFile = new Map<string, Array<{ id: string; x: number; y: number }>>();
        for (const p of msg.positions) {
          const source = graph.sourceById.get(p.id);
          if (!source) continue; // deleted between render and message
          const file = fileFor(source);
          (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(p);
        }
        let written = 0;
        for (const [file, positions] of byFile) {
          const wanted = new Map(positions.map((p) => [p.id, p]));
          mutateBrain(file, (brain) => {
            for (const node of brain.nodes) {
              const p = wanted.get(node.id);
              // Never overwrite a node that has since been settled by someone
              // else (the CLI's `layout`, another window) — first writer wins.
              if (!p || node.laidOut) continue;
              node.x = p.x;
              node.y = p.y;
              node.laidOut = true;
              written++;
            }
          });
        }
        // Nothing changed ⇒ don't rebroadcast. The watcher would fire anyway on
        // a real write; skipping here keeps a no-op message from looping.
        if (written === 0) return;
        logLine(`layout: settled ${written} node position(s)`);
        break;
      }

      case 'move': {
        // The reader dragged and dropped a node — explicit intent, so unlike
        // `layout` this ALWAYS overwrites, even a node that already has a
        // laidOut position. Same file-split logic as `layout`.
        const byFile = new Map<string, Array<{ id: string; x: number; y: number }>>();
        for (const p of msg.positions) {
          const source = graph.sourceById.get(p.id);
          if (!source) continue; // deleted between render and message
          const file = fileFor(source);
          (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(p);
        }
        let written = 0;
        for (const [file, positions] of byFile) {
          const wanted = new Map(positions.map((p) => [p.id, p]));
          mutateBrain(file, (brain) => {
            for (const node of brain.nodes) {
              const p = wanted.get(node.id);
              if (!p) continue;
              node.x = p.x;
              node.y = p.y;
              node.laidOut = true;
              written++;
            }
          });
        }
        if (written === 0) return;
        logLine(`move: repositioned ${written} node(s)`);
        break;
      }

      case 'createNodeRequest': {
        const title = await vscode.window.showInputBox({
          prompt: 'Title for the new brain node',
          placeHolder: 'e.g. Docker restart procedure',
          validateInput: (v) => (slug(v) ? null : 'Title must contain at least one letter or digit'),
        });
        if (!title) return;
        const id = slug(title);
        if (graph.sourceById.has(id)) {
          post(webview, { type: 'notice', text: `A node "${id}" already exists.` });
          return;
        }
        const pick = await vscode.window.showQuickPick([...CATEGORIES], {
          placeHolder: 'Category',
        });
        if (!pick) return;
        const source: NodeSource = vscode.workspace.workspaceFolders?.length ? 'project' : 'global';
        mutateBrain(fileFor(source), (brain) => {
          const category = asCategory(pick);
          upsertNode(brain, {
            id,
            title: title.slice(0, 80),
            category,
            content: 'Write the knowledge here — "When X, do Y because Z".',
            ...placeNode(category),
            origin: 'seed', // hand-authored knowledge is curated
            lastUpdated: new Date().toISOString(),
            recallCount: 0,
          });
        });
        broadcastGraph();
        await openNodeDoc(source, id, { focus: true }); // straight into editing
        return;
      }

      case 'setNodeFlags': {
        const source = graph.sourceById.get(msg.id);
        if (!source) return;
        mutateBrain(fileFor(source), (brain) => {
          const node = brain.nodes.find((n) => n.id === msg.id);
          if (!node) return;
          // absent = default — keeps brain.json clean of `false` noise
          if (typeof msg.private === 'boolean') node.private = msg.private || undefined;
          if (typeof msg.shared === 'boolean') node.shared = msg.shared || undefined;
        });
        // The disk watcher rebroadcasts and (if enabled) schedules the company
        // sync, so a privacy change re-syncs on its own.
        break;
      }

      case 'merge': {
        const pick = await vscode.window.showWarningMessage(
          'Consolidate the brain?\n\nThis merges the least-used learned nodes (about 25%) into their ' +
            'nearest neighbours — their knowledge is kept, not deleted. Curated and central nodes are ' +
            'always preserved.',
          { modal: true },
          'Merge',
        );
        if (pick !== 'Merge') return;
        post(webview, { type: 'busy', on: true });
        const target = fs.existsSync(paths.project) ? paths.project : paths.global;
        const folded = mutateBrain(target, (brain) => foldLeastUsed(brain, 0.25));
        post(webview, { type: 'busy', on: false });
        post(webview, {
          type: 'notice',
          text: folded > 0 ? `Merged ${folded} node${folded === 1 ? '' : 's'}` : 'Nothing to merge',
        });
        break;
      }
    }
    broadcastGraph();
  } catch (err) {
    post(webview, { type: 'busy', on: false });
    post(webview, {
      type: 'notice',
      text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── auto-model: type /model into the Claude terminal on novelty requests ─────
// Hooks cannot change a Claude Code session's model; the interactive /model
// command is the only mid-session lever. The nff-brain hooks score novelty and
// write .nff-brain/model-request.json — when nffBrain.autoModel is enabled we
// find the Claude terminal and type the command for the user. Best-effort by
// design: a missed request just leaves the session on its current model.

const MODEL_REQUEST_MAX_AGE_MS = 20_000; // older = leftover from a previous session
let lastHandledModelRequest = '';

interface ModelRequestShape {
  model?: string;
  novelty?: number;
  ts?: string;
  cwd?: string;
  sessionId?: string;
}

/**
 * A terminal that is actually running Claude — by NAME only.
 *
 * This used to fall back to any terminal whose cwd matched the workspace, and
 * then to the active terminal. Both were guesses, and they were wrong in the
 * common case: Claude Code runs in the native panel by default
 * (claudeCode.useTerminal is false), so there IS no Claude terminal and the
 * fallbacks typed `/model …` into whatever shell happened to be focused —
 * producing garbage like `...Activate.ps1)/model sonnet` in a PowerShell prompt,
 * or, when it did land in a Claude session, the "switching models will re-read
 * the full conversation" confirmation the user had to answer by hand.
 *
 * Nothing about an arbitrary shell says "this is Claude", so we no longer
 * pretend. No match → the caller logs and does nothing.
 */
function findClaudeTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find((t) => /claude/i.test(t.name));
}

function handleModelRequest(uri: vscode.Uri): void {
  try {
    const config = vscode.workspace.getConfiguration('nffBrain');
    if (!config.get<boolean>('autoModel')) return;

    let req: ModelRequestShape;
    try {
      req = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as ModelRequestShape;
    } catch {
      return; // half-written or gone — the watcher will fire again on rewrite
    }
    if (!req.model || !req.ts) return;

    const key = `${req.sessionId ?? ''}|${req.model}|${req.ts}`;
    if (key === lastHandledModelRequest) return;
    const age = Date.now() - Date.parse(req.ts);
    if (!Number.isFinite(age) || age < 0 || age > MODEL_REQUEST_MAX_AGE_MS) {
      logLine(`auto-model: ignoring stale request (ts=${req.ts})`);
      return;
    }
    // Multi-window safety: only act on requests for THIS workspace.
    if (req.cwd && path.resolve(req.cwd) !== path.resolve(paths.workspaceRoot)) return;

    const terminal = findClaudeTerminal();
    if (!terminal) {
      logLine(
        `auto-model: no terminal named "claude" — not typing /model ${req.model}. ` +
          `Claude Code runs in the native panel unless claudeCode.useTerminal is on; ` +
          `use \`nff-brain install-hooks --apply-model\` instead.`,
      );
      return;
    }
    lastHandledModelRequest = key;
    // Text and Enter sent separately — bracketed paste can swallow a trailing
    // newline inside the Claude TUI's input box.
    terminal.sendText(`/model ${req.model}`, false);
    setTimeout(() => terminal.sendText('', true), 150);
    logLine(`auto-model: sent /model ${req.model} (novelty=${req.novelty ?? '?'}) to terminal "${terminal.name}"`);
    if (config.get<boolean>('autoModelNotify')) {
      const nov = typeof req.novelty === 'number' ? ` (novelty ${req.novelty.toFixed(2)})` : '';
      vscode.window.setStatusBarMessage(`$(type-hierarchy-sub) nff-brain: /model ${req.model}${nov}`, 5_000);
    }
  } catch (err) {
    logLine(`auto-model FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function nonce(): string {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const n = nonce();
  // Strict CSP: no network, no remote anything — the bundle is the whole app.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>nff-brain</title>
  <style>html, body, #root { height: 100%; margin: 0; padding: 0; overflow: hidden; }</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}

function wireWebview(webview: vscode.Webview, extensionUri: vscode.Uri, disposables: vscode.Disposable[]): void {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
  webview.html = htmlFor(webview, extensionUri);
  channelViews.add(webview);
  disposables.push(webview.onDidReceiveMessage((msg: WebToExt) => void handleMessage(msg, webview)));
}

export function activate(context: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel('nff-brain');
  context.subscriptions.push(out);
  channelViews = new Set();
  extSecrets = context.secrets;
  void extSecrets.get(SECRET_COMPANY_SYNC_TOKEN).then((t) => {
    companySyncTokenPresent = !!t;
    if (companySyncTokenPresent) launcher?.refresh(); // show the sync row
  });
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  paths = resolveBrainPaths(cwd);
  logLine(`activated — workspace=${cwd} project=${paths.project} global=${paths.global}`);

  // Node documents: nffbrain:/<source>/<id>.md served straight from brain.json.
  brainFs = new BrainFs(paths, () => broadcastGraph());
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, brainFs, { isCaseSensitive: true }),
    vscode.languages.registerDocumentLinkProvider({ scheme: SCHEME }, new BrainLinkProvider()),
  );

  let panel: vscode.WebviewPanel | null = null;

  context.subscriptions.push(
    vscode.commands.registerCommand('nffBrain.open', () => {
      try {
        logLine('nffBrain.open invoked');
        if (panel) {
          panel.reveal();
          return;
        }
        panel = vscode.window.createWebviewPanel('nffBrain', 'nff-brain', vscode.ViewColumn.One, {
          enableScripts: true,
          retainContextWhenHidden: true,
        });
        // The capybara mascot as the editor-tab icon (instead of the generic file glyph).
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'capybara.png');
        const disposables: vscode.Disposable[] = [];
        // Capture the webview now: the panel is already marked disposed when
        // onDidDispose fires, so panel.webview would throw inside the handler
        // and leave `panel` stale (→ "Webview is disposed" on the next open).
        const webview = panel.webview;
        wireWebview(webview, context.extensionUri, disposables);
        panel.onDidDispose(() => {
          channelViews.delete(webview);
          for (const d of disposables) d.dispose();
          panel = null;
        });
        logLine('panel created');
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        logLine(`nffBrain.open FAILED: ${msg}`);
        void vscode.window.showErrorMessage(`nff-brain failed to open: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('nffBrain.refresh', () => broadcastGraph()),
    // Deleting a node = deleting its document; also reachable via this command.
    vscode.commands.registerCommand('nffBrain.deleteNode', async () => {
      const graph = loadGraph();
      if (graph.nodes.length === 0) return;
      const pick = await vscode.window.showQuickPick(
        graph.nodes.map((n) => ({ label: n.title, description: n.id, source: n.source })),
        { placeHolder: 'Delete which brain node?' },
      );
      if (!pick?.description) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete brain node "${pick.label}" and its links?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      brainFs.delete(nodeUri(pick.source, pick.description));
    }),
    // Re-settle EVERY node from scratch. The graph lays itself out incrementally
    // as nodes appear, which preserves the arrangement you have learned; this is
    // the deliberate escape hatch for when you want it rebuilt anyway.
    vscode.commands.registerCommand('nffBrain.layout', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Re-arrange the whole brain graph?\n\nEvery node is repositioned from scratch. Nothing is ' +
          'deleted, but the layout you are used to will change.',
        { modal: true },
        'Re-arrange',
      );
      if (confirm !== 'Re-arrange') return;
      let moved = 0;
      for (const file of [paths.project, paths.global]) {
        if (!fs.existsSync(file)) continue;
        const brain = loadSafe(file);
        if (!brain || brain.nodes.length === 0) continue;
        // Pure, so compute it before taking the lock.
        const pos = layoutBrain(brain.nodes, brain.edges, { minGap: 60 });
        mutateBrain(file, (b) => {
          for (const node of b.nodes) {
            const p = pos[node.id];
            if (!p) continue;
            node.x = p.x;
            node.y = p.y;
            node.laidOut = true;
            moved++;
          }
        });
      }
      broadcastGraph();
      void vscode.window.showInformationMessage(`nff-brain: re-arranged ${moved} node(s).`);
    }),
    vscode.commands.registerCommand('nffBrain.syncToCompany', () => void syncToCompany(true)),
    vscode.commands.registerCommand('nffBrain.setCompanySyncToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Paste your company sync token (an admin mints it in nff-admin ▸ Users ▸ Employee brains). Empty clears it.',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return; // dismissed
      if (!token.trim()) {
        await extSecrets.delete(SECRET_COMPANY_SYNC_TOKEN);
        companySyncTokenPresent = false;
        launcher?.refresh();
        void vscode.window.showInformationMessage('nff-brain: company sync token cleared.');
        return;
      }
      await extSecrets.store(SECRET_COMPANY_SYNC_TOKEN, token.trim());
      companySyncTokenPresent = true;
      await vscode.workspace
        .getConfiguration('nffBrain')
        .update('companySync.enabled', true, vscode.ConfigurationTarget.Global);
      launcher?.refresh();
      void vscode.window.showInformationMessage(
        'nff-brain: company sync token saved and sync enabled — "Sync Brain to Company" pushes now, and changes auto-sync.',
      );
    }),
  );

  // Activity-bar LAUNCHER: the nav-bar icon never renders the graph in the
  // sidebar — becoming visible just opens the full editor tab. The sidebar
  // itself is the scoreboard: Open Brain, plus the estimated context tokens
  // recall has saved. With an empty/absent brain it stays empty so the
  // viewsWelcome hint shows instead.
  launcher = new BrainLauncherProvider(() => {
    const merged = loadMerged();
    return {
      nodes: merged.nodes,
      edgeCount: merged.edges.length,
      sessionSaved,
      companySyncLastAt: companySyncTokenPresent ? companySyncLastAt : null,
    };
  });
  const launcherView = vscode.window.createTreeView('nffBrain.launcher', {
    treeDataProvider: launcher,
  });
  context.subscriptions.push(
    launcher,
    launcherView,
    launcherView.onDidChangeVisibility((e) => {
      if (e.visible) void vscode.commands.executeCommand('nffBrain.open');
    }),
  );

  // Status bar entry when a brain exists (or appears later).
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(type-hierarchy-sub) brain';
  status.tooltip = 'Open the nff-brain knowledge graph';
  status.command = 'nffBrain.open';
  context.subscriptions.push(status);
  const refreshStatus = () => {
    if (fs.existsSync(paths.project) || fs.existsSync(paths.global)) status.show();
  };
  refreshStatus();

  // Live updates: hook writes / CLI edits round-trip into any open view.
  let debounce: NodeJS.Timeout | null = null;
  const onDiskChange = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      refreshStatus();
      broadcastGraph();
      launcher?.refresh(); // recallCount bumps move the savings figure
      brainFs.notifyBrainChanged(); // open node docs reload from the new truth
      scheduleCompanySync(); // auto company sync rides the same disk signal
    }, 150);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/.nff-brain/brain.json');
  watcher.onDidChange(onDiskChange);
  watcher.onDidCreate(onDiskChange);
  watcher.onDidDelete(onDiskChange);
  context.subscriptions.push(watcher);

  // Vector sidecar → webview. Separate from the brain watcher on purpose: this
  // payload is ~840 KB at the node cap, so it must not ride the 150 ms graph
  // debounce that fires on every recallCount bump. `nff-brain index` writing
  // the sidecar is the only thing that changes it.
  let vectorDebounce: NodeJS.Timeout | null = null;
  const onVectorsChange = () => {
    if (vectorDebounce) clearTimeout(vectorDebounce);
    vectorDebounce = setTimeout(pushVectorsAll, 500);
  };
  const vectorWatcher = vscode.workspace.createFileSystemWatcher('**/.nff-brain/vectors.json');
  vectorWatcher.onDidChange(onVectorsChange);
  vectorWatcher.onDidCreate(onVectorsChange);
  vectorWatcher.onDidDelete(onVectorsChange);
  context.subscriptions.push(vectorWatcher);

  // Flipping nffBrain.semanticSearch takes effect without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nffBrain.semanticSearch')) pushVectorsAll();
    }),
  );

  // Auto-model requests from the hooks (session-start baseline + per-prompt).
  const modelWatcher = vscode.workspace.createFileSystemWatcher('**/.nff-brain/model-request.json');
  modelWatcher.onDidCreate(handleModelRequest);
  modelWatcher.onDidChange(handleModelRequest);
  context.subscriptions.push(modelWatcher);

  // Live activity → glow. Start at the file's current size: history is not
  // replayed here (the per-panel 'ready' replay handles that). Debounce is a
  // short 50ms — latency IS the feature — and offsets make extra fires cheap.
  try {
    activityOffset = fs.statSync(activityPath(paths.project)).size;
  } catch {
    activityOffset = 0;
  }
  let activityDebounce: NodeJS.Timeout | null = null;
  const onActivityChange = () => {
    if (activityDebounce) clearTimeout(activityDebounce);
    activityDebounce = setTimeout(relayActivity, 50);
  };
  const activityWatcher = vscode.workspace.createFileSystemWatcher('**/.nff-brain/activity.jsonl');
  activityWatcher.onDidCreate(onActivityChange);
  activityWatcher.onDidChange(onActivityChange);
  context.subscriptions.push(activityWatcher);
  try {
    const globalDir = path.dirname(paths.global);
    if (fs.existsSync(globalDir)) {
      const w = fs.watch(globalDir, (_ev, name) => {
        if (name === 'brain.json') onDiskChange();
      });
      context.subscriptions.push({ dispose: () => w.close() });
    }
  } catch {
    /* global watch is best-effort */
  }
}

export function deactivate(): void {
  /* nothing to clean up beyond subscriptions */
}
