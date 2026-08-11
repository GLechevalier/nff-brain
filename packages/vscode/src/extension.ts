import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  asCategory,
  CATEGORIES,
  foldLeastUsed,
  loadBrain,
  mergeBrains,
  mutateBrain,
  placeNode,
  resolveBrainPaths,
  slug,
  upsertNode,
  type BrainFile,
  type BrainPaths,
} from '@nff-brain/core';
import { BrainFs, BrainLinkProvider, nodeUri, SCHEME } from './brainFs';
import type { ExtToWeb, NodeSource, ViewEdge, ViewNode, WebToExt } from './protocol';

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

/** Open a node as its native markdown editor, in the column beside the graph. */
async function openNodeDoc(source: NodeSource, id: string, opts?: { focus?: boolean }): Promise<void> {
  await vscode.window.showTextDocument(nodeUri(source, id), {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: !opts?.focus,
  });
}

async function handleMessage(msg: WebToExt, webview: vscode.Webview): Promise<void> {
  const graph = loadGraph();
  try {
    switch (msg.type) {
      case 'ready':
        broadcastGraph();
        return;

      case 'openNode': {
        const source = graph.sourceById.get(msg.id);
        if (!source) return;
        await openNodeDoc(source, msg.id);
        return; // read-only action — no graph rebroadcast needed
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
  out = vscode.window.createOutputChannel('nff-brain');
  context.subscriptions.push(out);
  channelViews = new Set();
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
        wireWebview(panel.webview, context.extensionUri, disposables);
        panel.onDidDispose(() => {
          channelViews.delete(panel!.webview);
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
  );

  // Activity-bar LAUNCHER: the nav-bar icon never renders the graph in the
  // sidebar — becoming visible just opens the full editor tab. The tiny
  // sidebar panel only shows the viewsWelcome "Open Brain" hint.
  const launcher = vscode.window.createTreeView('nffBrain.launcher', {
    treeDataProvider: {
      getTreeItem: (e: vscode.TreeItem) => e,
      getChildren: () => [], // always empty → viewsWelcome content shows
    },
  });
  context.subscriptions.push(
    launcher,
    launcher.onDidChangeVisibility((e) => {
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
      brainFs.notifyBrainChanged(); // open node docs reload from the new truth
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
