// The review step: `nff-brain import` writes a preview and touches nothing
// else; `nff-brain import --apply` commits only what survived the review.
//
// TWO files are written, and the split is deliberate:
//   - import-preview.md   human, editable — owns checkbox state and any text
//                         the reviewer rewrote.
//   - import-pending.json machine — owns structure (ids, targets, status,
//                         provenance, ledger hashes).
// Deriving ids from the markdown instead would mean re-slugging a title the
// user may have just fixed a typo in, which would orphan the ledger entry and
// could silently collide with another node. So prose never decides identity.

import type { ImportKind } from './importExtract.js';
import type { PendingItem } from './importDedup.js';

export const PREVIEW_FILE = 'import-preview.md';
export const PENDING_FILE = 'import-pending.json';

export const SECTION_ORDER: ImportKind[] = ['memory', 'decision', 'preference', 'task', 'failure'];

export const SECTION_TITLE: Record<ImportKind, string> = {
  memory: 'Durable memories',
  decision: 'Architectural decisions',
  preference: 'Developer preferences',
  task: 'Unresolved tasks',
  failure: 'Previous failures & discoveries',
};

export interface PendingFile {
  version: 1;
  createdAt: string;
  workspaceRoot: string;
  brainPath: string;
  brainUpdatedAt: string;
  minConfidence: number;
  sessionsRead: string[];
  /** Size of each mined transcript, so the ledger can spot a resumed session. */
  sessionBytes?: Record<string, number>;
  items: PendingItem[];
}

function sourceLine(item: PendingItem): string {
  const n = item.sources.length;
  const shown = item.sources
    .slice(0, 2)
    .map((s) => `${JSON.stringify(s.title ?? s.sessionId.slice(0, 8))}${s.date ? ` (${s.date.slice(0, 10)})` : ''}`)
    .join(', ');
  const more = n > 2 ? `, +${n - 2}` : '';
  return `_${n} session${n === 1 ? '' : 's'} — ${shown}${more}_`;
}

export interface RenderContext {
  brainPath: string;
  sessionCount: number;
  createdAt: string;
  minConfidence: number;
}

export function renderImportPreview(items: readonly PendingItem[], ctx: RenderContext): string {
  const checked = items.filter((i) => i.checked).length;
  const known = items.filter((i) => i.status === 'duplicate').length;
  const unchecked = items.length - checked - known;

  const out: string[] = [
    `<!-- nff-brain import preview — generated ${ctx.createdAt}`,
    `     Uncheck anything you don't want. Edit any title or body freely.`,
    `     Delete a whole block to reject it outright.`,
    `     Then run:  nff-brain import --apply`,
    `     Keep the <!-- nb:… --> markers — they tie each item to ${PENDING_FILE}. -->`,
    ``,
    `# Import preview — ${items.length} ${items.length === 1 ? 'memory' : 'memories'} from ${ctx.sessionCount} session${ctx.sessionCount === 1 ? '' : 's'}`,
    ``,
    `> ${checked} checked (confidence ≥ ${ctx.minConfidence.toFixed(2)}) · ${unchecked} unchecked (low confidence) · ${known} already known`,
    `> brain: ${ctx.brainPath}`,
    ``,
  ];

  const render = (item: PendingItem): string[] => {
    const box = item.checked ? 'x' : ' ';
    const refines =
      item.status === 'refine' ? ` → refines \`${item.targetId}\`` : item.status === 'duplicate' ? ` → already \`${item.targetId}\`` : '';
    const block = [
      `- [${box}] **${item.title}** \`${item.confidence.toFixed(2)}\`${refines} <!-- nb:${item.key} -->`,
      ...item.content.split('\n').map((l) => `  ${l}`),
    ];
    if (item.previousContent) block.push(`  > was: ${item.previousContent.replace(/\n/g, ' ').slice(0, 240)}`);
    block.push(`  ${sourceLine(item)}`, ``);
    return block;
  };

  for (const kind of SECTION_ORDER) {
    const section = items.filter((i) => i.kind === kind && i.status !== 'duplicate');
    if (!section.length) continue;
    out.push(`## ${SECTION_TITLE[kind]} (${section.length})`, ``);
    for (const item of section) out.push(...render(item));
  }

  const dupes = items.filter((i) => i.status === 'duplicate');
  if (dupes.length) {
    out.push(
      `## Already known (${dupes.length})`,
      ``,
      `_The brain has these. Left unchecked; tick one to overwrite it with the wording below._`,
      ``,
    );
    for (const item of dupes) out.push(...render(item));
  }

  if (!items.length) {
    out.push(`Nothing worth keeping was found in those sessions.`, ``);
  }

  return out.join('\n');
}

export interface PreviewEdit {
  checked: boolean;
  title: string;
  content: string;
}

export interface ParsedPreview {
  edits: Map<string, PreviewEdit>;
  warnings: string[];
}

const ITEM_START = /^-\s*\[([ xX])\]\s*\*\*(.+?)\*\*.*?<!--\s*nb:([A-Za-z0-9_-]+)\s*-->/;
const HEADING = /^#{1,6}\s/;

/**
 * Read the reviewed markdown back.
 *
 * Line-by-line rather than one regex over the document: a reviewer edits this
 * by hand, so the parser has to survive rewrapped paragraphs, changed
 * indentation and deleted blocks without ever mis-attributing a body to the
 * wrong item.
 */
export function parseImportPreview(md: string): ParsedPreview {
  const edits = new Map<string, PreviewEdit>();
  const warnings: string[] = [];
  const lines = (md ?? '').split(/\r?\n/);

  let current: { key: string; checked: boolean; title: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    if (edits.has(current.key)) {
      warnings.push(`duplicate marker nb:${current.key} — kept the first`);
    } else {
      edits.set(current.key, {
        checked: current.checked,
        title: current.title,
        content: current.body.join('\n').trim(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const m = line.match(ITEM_START);
    if (m) {
      flush();
      current = { key: m[3], checked: m[1].toLowerCase() === 'x', title: m[2].trim(), body: [] };
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      continue;
    }
    if (!current) {
      // An unchecked-looking bullet with no marker is a block whose marker was
      // damaged; warn once rather than silently dropping it without a trace.
      if (/^-\s*\[[ xX]\]/.test(line)) warnings.push(`ignored an item with no nb: marker: ${line.trim().slice(0, 60)}`);
      continue;
    }
    const t = line.trim();
    if (t.startsWith('<!--')) continue; // comments
    if (t.startsWith('_') && t.endsWith('_')) continue; // provenance line
    if (t.startsWith('> was:')) continue; // the previous-content quote
    current.body.push(line.startsWith('  ') ? line.slice(2) : line);
  }
  flush();

  return { edits, warnings };
}

export interface ResolvedItem extends PendingItem {
  edited: boolean;
}

export interface ResolveResult {
  accepted: ResolvedItem[];
  rejected: number;
  warnings: string[];
}

/**
 * Combine the machine-readable pending list with the reviewed markdown.
 *
 * Rules that matter:
 *   - Edited title and body WIN. That is the whole point of an editable file.
 *   - An edited title does NOT change the node id. The id was collision-checked
 *     when the preview was written; re-slugging here could silently collide
 *     with another node and would orphan the ledger entry.
 *   - An item missing from the markdown counts as REJECTED. Deleting a block is
 *     the natural way to say no, and must never resurrect the item.
 */
export function resolvePreview(pending: PendingFile, md: string): ResolveResult {
  const { edits, warnings } = parseImportPreview(md);
  const accepted: ResolvedItem[] = [];
  let rejected = 0;

  for (const item of pending.items) {
    const edit = edits.get(item.key);
    if (!edit || !edit.checked) {
      rejected += 1;
      continue;
    }
    const title = edit.title || item.title;
    const content = edit.content || item.content;
    accepted.push({
      ...item,
      title,
      content,
      edited: title !== item.title || content !== item.content,
    });
  }

  const known = new Set(pending.items.map((i) => i.key));
  for (const key of edits.keys()) {
    if (!known.has(key)) warnings.push(`unknown marker nb:${key} — no such pending item, skipped`);
  }

  return { accepted, rejected, warnings };
}
