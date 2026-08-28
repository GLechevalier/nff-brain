import * as vscode from 'vscode';
import { brainSavings, formatTokens, type BrainNode } from '@nff-brain/core';

// The activity-bar side view. It is a LAUNCHER, not a second graph: it opens
// the editor tab and reports what the brain has bought you — an estimate of the
// context tokens recall saved by injecting knowledge the agent would otherwise
// have re-derived from the repo.
//
// Note the tree is either empty (no brain yet → package.json's viewsWelcome
// "Open Brain" content renders instead) or carries its own Open Brain row:
// VS Code hides welcome content as soon as a view has children, so the button
// has to live here too.

export interface LauncherStats {
  nodes: BrainNode[];
  edgeCount: number;
  /** Tokens saved since this window opened — already part of the lifetime total. */
  sessionSaved: number;
  /** Company sync: null = no token saved (row hidden), else last-synced ISO or '' (never). */
  companySyncLastAt: string | null;
}

const TOOLTIP_ASSUMPTION =
  'Estimated context tokens the brain saved by recalling knowledge instead of ' +
  'letting the agent rediscover it (grep + re-read + re-derive). An estimate, not a measurement.';

export class BrainLauncherProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly stats: () => LauncherStats) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const { nodes, edgeCount, sessionSaved, companySyncLastAt } = this.stats();
    if (nodes.length === 0) return []; // → viewsWelcome ("Open Brain" / init hint)

    const saved = brainSavings(nodes);
    const items: vscode.TreeItem[] = [
      item('Open Brain', 'type-hierarchy-sub', {
        tooltip: 'Open the knowledge graph in an editor tab',
        command: 'nffBrain.open',
      }),
      item(`≈ ${formatTokens(saved.total)} tokens saved`, 'sparkle', {
        description: `est. · ${saved.injections} injection${saved.injections === 1 ? '' : 's'}`,
        tooltip: savingsTooltip(saved),
      }),
    ];
    if (sessionSaved > 0) {
      items.push(
        item(`+${formatTokens(sessionSaved)} this session`, 'pulse', {
          tooltip: 'Saved since this window opened — already counted in the total above.',
        }),
      );
    }
    items.push(
      item(`${nodes.length} node${nodes.length === 1 ? '' : 's'} · ${edgeCount} link${edgeCount === 1 ? '' : 's'}`, 'circuit-board', {
        tooltip: 'Open the knowledge graph in an editor tab',
        command: 'nffBrain.open',
      }),
    );
    if (companySyncLastAt !== null) {
      items.push(
        item('Sync to company', 'cloud-upload', {
          description: companySyncLastAt ? `last synced ${new Date(companySyncLastAt).toLocaleTimeString()}` : 'never synced',
          tooltip: 'Push this brain to the company brain now (nodes marked private are never sent)',
          command: 'nffBrain.syncToCompany',
        }),
      );
    }
    return items;
  }
}

function item(
  label: string,
  icon: string,
  opts: { description?: string; tooltip?: string | vscode.MarkdownString; command?: string },
): vscode.TreeItem {
  const t = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  t.iconPath = new vscode.ThemeIcon(icon);
  if (opts.description) t.description = opts.description;
  if (opts.tooltip) t.tooltip = opts.tooltip;
  if (opts.command) t.command = { command: opts.command, title: label };
  return t;
}

function savingsTooltip(saved: ReturnType<typeof brainSavings>): vscode.MarkdownString {
  const rows: Array<[string, number]> = [
    ['distilled from sessions', saved.byOrigin.agent],
    ['curated', saved.byOrigin.seed],
    ['codebase map', saved.byOrigin.graphify],
  ];
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**≈ ${formatTokens(saved.total)} context tokens saved**\n\n`);
  md.appendMarkdown(`${TOOLTIP_ASSUMPTION}\n\n`);
  for (const [label, value] of rows) {
    if (value > 0) md.appendMarkdown(`- ${label}: ${formatTokens(value)}\n`);
  }
  md.appendMarkdown(`\nAcross ${saved.injections} node injection${saved.injections === 1 ? '' : 's'}.`);
  return md;
}
