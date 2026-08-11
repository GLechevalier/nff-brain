import * as vscode from 'vscode';
import {
  loadBrain,
  mutateBrain,
  parseNodeMd,
  removeNode,
  serializeNodeMd,
  type BrainFile,
  type BrainNode,
  type BrainPaths,
} from '@nff-brain/core';

// Virtual filesystem: every brain node is a real markdown document at
// nffbrain:/<project|global>/<id>.md. Opening a node in the graph opens a
// native editor tab; saving the tab writes title/category/body/links back into
// brain.json under the store lock. This is what makes the "memory document" a
// first-class VS Code editor instead of UI inside the webview.

export const SCHEME = 'nffbrain';

export function nodeUri(source: 'project' | 'global', id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${source}/${id}.md` });
}

function parseUri(uri: vscode.Uri): { source: 'project' | 'global'; id: string } | null {
  const m = uri.path.match(/^\/(project|global)\/(.+)\.md$/);
  if (!m) return null;
  return { source: m[1] as 'project' | 'global', id: m[2] };
}

export class BrainFs implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    private readonly paths: BrainPaths,
    private readonly onMutation: () => void, // refresh graph views after a save
  ) {}

  private fileFor(source: 'project' | 'global'): string {
    return source === 'project' ? this.paths.project : this.paths.global;
  }

  private loadSafe(source: 'project' | 'global'): BrainFile | null {
    try {
      return loadBrain(this.fileFor(source));
    } catch {
      return null;
    }
  }

  private render(source: 'project' | 'global', node: BrainNode, brain: BrainFile): string {
    const titleById = new Map(brain.nodes.map((n) => [n.id, n.title]));
    const links = brain.edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => {
        const other = e.from === node.id ? e.to : e.from;
        return { id: other, strength: e.strength, title: titleById.get(other) };
      })
      .sort((a, b) => b.strength - a.strength);
    return serializeNodeMd(node, links, { source });
  }

  /** Fire change/delete events for open nffbrain documents after brain.json moved. */
  notifyBrainChanged(): void {
    const events: vscode.FileChangeEvent[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== SCHEME) continue;
      const ref = parseUri(doc.uri);
      if (!ref) continue;
      const brain = this.loadSafe(ref.source);
      events.push({
        type: brain?.nodes.some((n) => n.id === ref.id)
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Deleted,
        uri: doc.uri,
      });
    }
    if (events.length) this.emitter.fire(events);
  }

  // ── FileSystemProvider ───────────────────────────────────────────────────────

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path === '/' || uri.path === '/project' || uri.path === '/global') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const ref = parseUri(uri);
    const brain = ref && this.loadSafe(ref.source);
    const node = brain?.nodes.find((n) => n.id === ref!.id);
    if (!ref || !brain || !node) throw vscode.FileSystemError.FileNotFound(uri);
    const mtime = Date.parse(node.lastUpdated) || 0;
    return {
      type: vscode.FileType.File,
      ctime: mtime,
      mtime,
      size: Buffer.byteLength(this.render(ref.source, node, brain), 'utf8'),
    };
  }

  readDirectory(uri: vscode.Uri): Array<[string, vscode.FileType]> {
    if (uri.path === '/' || uri.path === '') {
      return [
        ['project', vscode.FileType.Directory],
        ['global', vscode.FileType.Directory],
      ];
    }
    const source = uri.path === '/project' ? 'project' : uri.path === '/global' ? 'global' : null;
    if (!source) throw vscode.FileSystemError.FileNotFound(uri);
    const brain = this.loadSafe(source);
    return (brain?.nodes ?? []).map((n) => [`${n.id}.md`, vscode.FileType.File]);
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const ref = parseUri(uri);
    const brain = ref && this.loadSafe(ref.source);
    const node = brain?.nodes.find((n) => n.id === ref!.id);
    if (!ref || !brain || !node) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(this.render(ref.source, node, brain), 'utf8');
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const ref = parseUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    const parsed = parseNodeMd(Buffer.from(content).toString('utf8'));
    if (!parsed.title) {
      throw vscode.FileSystemError.NoPermissions(
        'The document needs a `# Title` heading — the node title comes from it.',
      );
    }
    mutateBrain(this.fileFor(ref.source), (brain) => {
      const node = brain.nodes.find((n) => n.id === ref.id);
      if (!node) throw vscode.FileSystemError.FileNotFound(uri);
      node.title = parsed.title;
      node.category = parsed.category;
      node.content = parsed.content;
      node.lastUpdated = new Date().toISOString();

      // Reconcile this node's edges with the parsed links list. Links may point
      // at any node known to this file; unknown ids are dropped silently (they
      // stay visible in the text until the next reload shows the truth).
      const known = new Set(brain.nodes.map((n) => n.id));
      brain.edges = brain.edges.filter((e) => e.from !== ref.id && e.to !== ref.id);
      for (const l of parsed.links) {
        if (!known.has(l.id) || l.id === ref.id) continue;
        brain.edges.push({ from: ref.id, to: l.id, strength: l.strength });
      }
    });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.onMutation();
  }

  delete(uri: vscode.Uri): void {
    const ref = parseUri(uri);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    mutateBrain(this.fileFor(ref.source), (brain) => removeNode(brain, ref.id));
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    this.onMutation();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Brain node ids cannot be renamed.');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('The brain filesystem has a fixed layout.');
  }
}

/** Ctrl+click navigation for [[node-id]] references inside node documents. */
export class BrainLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const ref = parseUri(doc.uri);
    if (!ref) return [];
    const links: vscode.DocumentLink[] = [];
    const re = /\[\[([^\]\s]+)\]\]/g;
    const text = doc.getText();
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const range = new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length));
      const link = new vscode.DocumentLink(range, nodeUri(ref.source, m[1]));
      link.tooltip = `Open ${m[1]}`;
      links.push(link);
    }
    return links;
  }
}
