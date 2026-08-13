// What the web agent "sees": a DOM/a11y-derived snapshot of the interactive
// elements on a page, addressed by stable short refs (e1, e2, …) that the
// action verbs (browserVerbs.ts) target. This is the perception half of the
// contract; browserVerbs.ts is the action half.
//
// Refs are only valid against the snapshotId that produced them — the engine
// keeps a ref→backendNodeId map per snapshot and refuses an action carrying a
// stale snapshotId rather than acting on whatever now occupies that position.
//
// Pure, node-free (browser-safe like clip.ts). The token-lean text form the
// LLM actually reads is renderSnapshotText() here; the DOM-walking that
// PRODUCES a snapshot lives in the extension (snapshotScript.ts), not here, so
// this file stays free of any DOM dependency and is unit-testable in isolation.

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapElementState {
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
}

export interface SnapElement {
  /** "e12" — stable within one snapshotId only. */
  ref: string;
  /** ARIA role or a coarse tag fallback: button/link/textbox/checkbox/combobox/slider/… */
  role: string;
  /** Accessible name / label / trimmed text. */
  name: string;
  /** Current value. ALWAYS omitted for password inputs — never read into a snapshot. */
  value?: string;
  state?: SnapElementState;
  rect: SnapRect;
  inViewport: boolean;
  /** Present when the element is itself a scroll container. */
  scrollable?: { maxDx: number; maxDy: number };
  href?: string;
}

export interface SnapFrame {
  frameId: string;
  url: string;
  crossOrigin: boolean;
}

export interface SnapDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
}

export interface PageSnapshot {
  /** "s3" — refs in `elements` are valid only against this id. */
  snapshotId: string;
  url: string;
  title: string;
  tabId: number;
  viewport: { w: number; h: number; scrollX: number; scrollY: number; pageH: number };
  elements: SnapElement[];
  frames: SnapFrame[];
  dialog?: SnapDialog;
  /** Only in mode:'text' — main-content extraction, capped. */
  text?: string;
}

export const MAX_SNAP_NAME = 80;
export const MAX_SNAP_VALUE = 120;
export const MAX_SNAP_TEXT = 8000;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function stateFlags(el: SnapElement): string {
  const s = el.state;
  if (!s) return '';
  const flags: string[] = [];
  if (s.checked) flags.push('checked');
  if (s.selected) flags.push('selected');
  if (s.expanded) flags.push('expanded');
  if (s.disabled) flags.push('disabled');
  if (s.focused) flags.push('focused');
  return flags.length ? ' ' + flags.join(',') : '';
}

/**
 * Render a snapshot as the compact text the model reads. Deterministic and
 * pure — golden-tested. One element per line:
 *
 *   e3 button "Pay now" @412,610 120x44 [below fold]
 *   e1 textbox "Email" value="g@x.com" @412,180 300x36
 *   e4 div scrollable(maxDy 1200) "Order summary…" @760,120 400x520
 */
export function renderSnapshotText(snap: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`[${snap.snapshotId}] ${snap.url} — "${clip(snap.title, MAX_SNAP_NAME)}"`);
  lines.push(
    `viewport ${Math.round(snap.viewport.w)}x${Math.round(snap.viewport.h)} ` +
      `scrolled ${Math.round(snap.viewport.scrollX)},${Math.round(snap.viewport.scrollY)} ` +
      `of ${Math.round(snap.viewport.pageH)}`,
  );

  for (const el of snap.elements) {
    let line = `${el.ref} ${el.role}`;
    if (el.scrollable && (el.scrollable.maxDx > 0 || el.scrollable.maxDy > 0)) {
      const parts: string[] = [];
      if (el.scrollable.maxDx > 0) parts.push(`maxDx ${Math.round(el.scrollable.maxDx)}`);
      if (el.scrollable.maxDy > 0) parts.push(`maxDy ${Math.round(el.scrollable.maxDy)}`);
      line += ` scrollable(${parts.join(' ')})`;
    }
    if (el.name) line += ` "${clip(el.name, MAX_SNAP_NAME)}"`;
    if (el.value !== undefined) line += ` value="${clip(el.value, MAX_SNAP_VALUE)}"`;
    line += stateFlags(el);
    line += ` @${Math.round(el.rect.x)},${Math.round(el.rect.y)} ${Math.round(el.rect.w)}x${Math.round(el.rect.h)}`;
    if (!el.inViewport) line += ' [below fold]';
    if (el.href) line += ` -> ${el.href}`;
    lines.push(line);
  }

  for (const f of snap.frames) {
    lines.push(`~ frame ${f.crossOrigin ? '(cross-origin) ' : ''}${f.url}`);
  }

  if (snap.dialog) {
    lines.push(`! dialog ${snap.dialog.type}: "${clip(snap.dialog.message, MAX_SNAP_NAME)}"`);
  }

  if (snap.text !== undefined) {
    lines.push('---');
    lines.push(snap.text.slice(0, MAX_SNAP_TEXT));
  }

  return lines.join('\n');
}

/** A short header (url + element count) for the auto-append after navigation. */
export function renderSnapshotHeader(snap: PageSnapshot): string {
  return `[${snap.snapshotId}] ${snap.url} — ${snap.elements.length} interactive elements. Call read_page for detail.`;
}
