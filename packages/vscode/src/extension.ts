import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  asCategory,
  clampStrength,
  foldLeastUsed,
  loadBrain,
  mergeBrains,
  mutateBrain,
  placeNode,
  removeNode,
  resolveBrainPaths,
  slug,
  upsertEdge,
  upsertNode,
  type BrainFile,
  type BrainPaths,
} from '@nff-brain/core';
import type { ExtToWeb, NodeSource, ViewEdge, ViewNode, WebToExt } from './protocol';

// The extension host is the SOLE filesystem authority: every mutation goes
// through core's lock + atomic write, and the webview only renders what it is
// posted. A change on disk (e.g. the SessionEnd hook distilling new nodes while
// the panel is open) round-trips through the watcher back into the webview.

let channelViews: Set<vscode.Webview>;
let paths: BrainPaths;

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

function loadGraph(): GraphSnapshot {
  const merged = mergeBrains(loadSafe(paths.project), loadSafe(paths.global));
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
    lastUpdated: n.lastUpdated,
    recallCount: n.recallCount ?? 0,
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

/** The file that actually persists this edge (project first, then global). */
function edgeFile(from: string, to: string): string | null {
  for (const p of [paths.project, paths.global]) {
    const b = loadSafe(p);
    if (b?.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) {
      return p;
    }
  }
  return null;
}

async function handleMessage(msg: WebToExt, webview: vscode.Webview): Promise<void> {
  const graph = loadGraph();
  try {
    switch (msg.type) {
      case 'ready':
        broadcastGraph();
        return;

      case 'createNode': {
        const id = slug(msg.title);
        if (!id) {
          post(webview, { type: 'notice', text: 'Title produced an empty id — pick a different title.' });
          return;
        }
        if (graph.sourceById.has(id)) {
          post(webview, { type: 'notice', text: `A node "${id}" already exists.` });
          return;
        }
        const target = vscode.workspace.workspaceFolders?.length ? paths.project : paths.global;
        mutateBrain(target, (brain) => {
          const category = asCategory(msg.category);
          upsertNode(brain, {
            id,
            title: msg.title.slice(0, 80),
            category,
            content: msg.content.slice(0, 1200),
            ...placeNode(category),
            origin: 'seed', // hand-authored knowledge is curated
            lastUpdated: new Date().toISOString(),
            recallCount: 0,
          });
        });
        post(webview, { type: 'notice', text: `Added ${id}` });
        break;
      }

      case 'editNode': {
        const source = graph.sourceById.get(msg.id);
        if (!source) return;
        mutateBrain(fileFor(source), (brain) => {
          const node = brain.nodes.find((n) => n.id === msg.id);
          if (!node) return;
          node.title = msg.title.slice(0, 80);
          node.category = asCategory(msg.category);
          node.content = msg.content.slice(0, 1200);
          node.lastUpdated = new Date().toISOString();
        });
        break;
      }

      case 'deleteNode': {
        const source = graph.sourceById.get(msg.id);
        if (!source) return;
        const node = graph.nodes.find((n) => n.id === msg.id);
        const pick = await vscode.window.showWarningMessage(
          `Delete brain node "${node?.title ?? msg.id}" and its links?`,
          { modal: true },
          'Delete',
        );
        if (pick !== 'Delete') return;
        mutateBrain(fileFor(source), (brain) => removeNode(brain, msg.id));
        post(webview, { type: 'notice', text: `Deleted ${msg.id}` });
        break;
      }

      case 'addEdgeRequest': {
        const from = graph.nodes.find((n) => n.id === msg.from);
        if (!from) return;
        // Endpoints must live in the same file to persist the edge.
        const candidates = graph.nodes.filter(
          (n) => n.id !== msg.from && n.source === from.source && !from.relatedIds.includes(n.id),
        );
        if (candidates.length === 0) {
          post(webview, { type: 'notice', text: 'No unlinked nodes available in the same brain file.' });
          return;
        }
        const pick = await vscode.window.showQuickPick(
          candidates.map((n) => ({ label: n.title, description: n.id })),
          { placeHolder: `Link "${from.title}" to…` },
        );
        if (!pick?.description) return;
        mutateBrain(fileFor(from.source), (brain) =>
          upsertEdge(brain, { from: msg.from, to: pick.description!, strength: 0.6 }),
        );
        break;
      }

      case 'removeEdge': {
        const file = edgeFile(msg.from, msg.to);
        if (!file) return;
        mutateBrain(file, (brain) => {
          brain.edges = brain.edges.filter(
            (e) => !((e.from === msg.from && e.to === msg.to) || (e.from === msg.to && e.to === msg.from)),
          );
        });
        break;
      }

      case 'reinforce': {
        const file = edgeFile(msg.from, msg.to);
        if (!file) return;
        mutateBrain(file, (brain) => {
          const edge = brain.edges.find(
            (e) => (e.from === msg.from && e.to === msg.to) || (e.from === msg.to && e.to === msg.from),
          );
          if (edge) edge.strength = clampStrength(edge.strength + msg.delta);
        });
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
  channelViews = new Set();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  paths = resolveBrainPaths(cwd);

  let panel: vscode.WebviewPanel | null = null;

  context.subscriptions.push(
    vscode.commands.registerCommand('nffBrain.open', () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = vscode.window.createWebviewPanel('nffBrain', 'nff-brain', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      const disposables: vscode.Disposable[] = [];
      wireWebview(panel.webview, context.extensionUri, disposables);
      panel.onDidDispose(() => {
        channelViews.delete(panel!.webview);
        for (const d of disposables) d.dispose();
        panel = null;
      });
    }),
    vscode.commands.registerCommand('nffBrain.refresh', () => broadcastGraph()),
  );

  // Sidebar view (activity-bar icon) — same app, compact layout via container width.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'nffBrain.sideView',
      {
        resolveWebviewView(view) {
          const disposables: vscode.Disposable[] = [];
          wireWebview(view.webview, context.extensionUri, disposables);
          view.onDidDispose(() => {
            channelViews.delete(view.webview);
            for (const d of disposables) d.dispose();
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
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
    }, 150);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/.nff-brain/brain.json');
  watcher.onDidChange(onDiskChange);
  watcher.onDidCreate(onDiskChange);
  watcher.onDidDelete(onDiskChange);
  context.subscriptions.push(watcher);
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
