// The web agent's action vocabulary — the stable contract shared by the CDP
// engine (packages/chrome/src/actEngine.ts), the recorder/replay pipeline
// (trace.ts, workflow.ts), and the LLM tool layer (packages/chrome/src/
// actTools.ts). EPIC-chrome.md item 7 originally pinned this to three
// LinkedIn-only verbs "never arbitrary DOM eval"; this widens the vocabulary
// to a full browser-interaction set while keeping the SAME invariant — every
// verb is enumerated and validated here, and nothing in it evaluates
// caller-supplied script. The only script the engine ever runs is its own
// bundled snapshot/cursor function.
//
// Pure, node-free (browser-safe, like clip.ts / pageSnapshot.ts): the SW
// bundle and the vscode webview both import it. Every validator is tolerant
// and clamping — a caller (LLM tool call, a replayed workflow step, a resumed
// journal entry) is untrusted input.

// ── shared operands ──────────────────────────────────────────────────────────

/** Keyboard/mouse modifier flags. Absent === false. */
export interface Modifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Where an action lands. `ByRef` addresses an element from a specific page
 * snapshot — the engine rejects it if `snapshotId` is stale (the page changed
 * since it was read), never clicking the wrong thing. `ByPoint` is a raw
 * viewport coordinate, for canvases/maps/sliders where no element ref exists.
 */
export type Target = { ref: string; snapshotId: string } | { x: number; y: number };

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Named keys the agent may press. Printable single characters are also allowed
 * (validated separately) so `key.press` can send e.g. "a" for Ctrl+A. This set
 * is the non-printable vocabulary; the US-layout code/VK table lives in the
 * engine, not here.
 */
export const NAMED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

// ── the verb union ───────────────────────────────────────────────────────────

export interface PointerMoveVerb {
  kind: 'pointer.move';
  target: Target;
}
export interface PointerClickVerb {
  kind: 'pointer.click';
  target: Target;
  button: MouseButton;
  /** 1 = single, 2 = double, 3 = triple. */
  clickCount: 1 | 2 | 3;
  modifiers?: Modifiers;
}
export interface PointerDownVerb {
  kind: 'pointer.down';
  target: Target;
  button: MouseButton;
}
export interface PointerUpVerb {
  kind: 'pointer.up';
  target: Target;
  button: MouseButton;
}
export interface PointerDragVerb {
  kind: 'pointer.drag';
  from: Target;
  to: Target;
  /** Intermediate mouse-move samples between press and release. Default engine-chosen. */
  steps?: number;
  modifiers?: Modifiers;
}
export interface ScrollWheelVerb {
  kind: 'scroll.wheel';
  target: Target;
  dx: number;
  dy: number;
  /** ctrl:true turns the wheel into page zoom. */
  modifiers?: Modifiers;
}
export interface ScrollIntoViewVerb {
  kind: 'scroll.intoView';
  ref: string;
  snapshotId: string;
}
export interface KeyPressVerb {
  kind: 'key.press';
  /** A NamedKey or a single printable character. */
  key: string;
  modifiers?: Modifiers;
  /** Repeat the press this many times (default 1). */
  count?: number;
}
export interface KeyTypeVerb {
  kind: 'key.type';
  text: string;
  /** 'insert' = fast Input.insertText; 'keys' = per-character key events for handlers that need them. */
  mode?: 'insert' | 'keys';
}
export interface ElementFocusVerb {
  kind: 'element.focus';
  ref: string;
  snapshotId: string;
}
export interface FormSetValueVerb {
  kind: 'form.setValue';
  ref: string;
  snapshotId: string;
  value: string;
}
export interface FormUploadVerb {
  kind: 'form.upload';
  ref: string;
  snapshotId: string;
  /** Absolute disk paths — only resolvable in paired mode (a server writes the file). */
  paths: string[];
}
export interface PageReadVerb {
  kind: 'page.read';
  mode?: 'interactive' | 'text';
  filter?: string;
}
export interface PageFindVerb {
  kind: 'page.find';
  query: string;
}
export interface PageScreenshotVerb {
  kind: 'page.screenshot';
}
export interface PageZoomVerb {
  kind: 'page.zoom';
  factor: number;
}
export interface NavGotoVerb {
  kind: 'nav.goto';
  url: string;
}
export interface NavBackVerb {
  kind: 'nav.back';
}
export interface NavForwardVerb {
  kind: 'nav.forward';
}
export interface NavReloadVerb {
  kind: 'nav.reload';
  hard?: boolean;
}
export interface NavWaitForVerb {
  kind: 'nav.waitFor';
  until: 'load' | 'idle';
  timeoutMs?: number;
}
export interface TabOpenVerb {
  kind: 'tab.open';
  url: string;
  active?: boolean;
}
export interface TabCloseVerb {
  kind: 'tab.close';
  tabId: number;
}
export interface TabSwitchVerb {
  kind: 'tab.switch';
  tabId: number;
}
export interface TabDuplicateVerb {
  kind: 'tab.duplicate';
  tabId: number;
}
export interface TabListVerb {
  kind: 'tab.list';
}
export interface DialogHandleVerb {
  kind: 'dialog.handle';
  accept: boolean;
  promptText?: string;
}
export interface TouchTapVerb {
  kind: 'touch.tap';
  target: Target;
}
export interface TouchSwipeVerb {
  kind: 'touch.swipe';
  from: Target;
  to: Target;
  durationMs?: number;
}

export type BrowserVerb =
  | PointerMoveVerb
  | PointerClickVerb
  | PointerDownVerb
  | PointerUpVerb
  | PointerDragVerb
  | ScrollWheelVerb
  | ScrollIntoViewVerb
  | KeyPressVerb
  | KeyTypeVerb
  | ElementFocusVerb
  | FormSetValueVerb
  | FormUploadVerb
  | PageReadVerb
  | PageFindVerb
  | PageScreenshotVerb
  | PageZoomVerb
  | NavGotoVerb
  | NavBackVerb
  | NavForwardVerb
  | NavReloadVerb
  | NavWaitForVerb
  | TabOpenVerb
  | TabCloseVerb
  | TabSwitchVerb
  | TabDuplicateVerb
  | TabListVerb
  | DialogHandleVerb
  | TouchTapVerb
  | TouchSwipeVerb;

export type VerbKind = BrowserVerb['kind'];

// ── verb classes (the gate's unit — see actGate.ts) ──────────────────────────

/**
 * observe    — reads only, never mutates the page or navigates. Auto-granted.
 * navigate   — moves between pages/tabs. Granted for the whole run at start.
 * interact   — dispatches trusted input into the page. First use per origin
 *              needs a user grant.
 * destructive — hard to undo (closing others' tabs, uploading a file, handling
 *              an auth dialog). Always confirmed unless the origin is "Always".
 */
export type VerbClass = 'observe' | 'interact' | 'navigate' | 'destructive';

const VERB_CLASS: Record<VerbKind, VerbClass> = {
  'pointer.move': 'interact',
  'pointer.click': 'interact',
  'pointer.down': 'interact',
  'pointer.up': 'interact',
  'pointer.drag': 'interact',
  'scroll.wheel': 'interact',
  'scroll.intoView': 'interact',
  'key.press': 'interact',
  'key.type': 'interact',
  'element.focus': 'interact',
  'form.setValue': 'interact',
  'form.upload': 'destructive',
  'page.read': 'observe',
  'page.find': 'observe',
  'page.screenshot': 'observe',
  'page.zoom': 'observe',
  'nav.goto': 'navigate',
  'nav.back': 'navigate',
  'nav.forward': 'navigate',
  'nav.reload': 'navigate',
  'nav.waitFor': 'observe',
  'tab.open': 'navigate',
  'tab.close': 'destructive',
  'tab.switch': 'navigate',
  'tab.duplicate': 'navigate',
  'tab.list': 'observe',
  'dialog.handle': 'destructive',
  'touch.tap': 'interact',
  'touch.swipe': 'interact',
};

export function verbClass(v: BrowserVerb): VerbClass {
  return VERB_CLASS[v.kind];
}

// ── validation ───────────────────────────────────────────────────────────────

export const MAX_TYPE_TEXT = 4000;
export const MAX_SET_VALUE = 4000;
export const MAX_FILTER = 200;
export const MAX_FIND_QUERY = 200;
export const MAX_PROMPT_TEXT = 2000;
export const MAX_UPLOAD_FILES = 10;
export const MAX_DRAG_STEPS = 100;
export const MAX_KEY_COUNT = 100;
/** Wheel/zoom deltas are clamped to sane magnitudes so a bad number can't spin forever. */
export const MAX_WHEEL_DELTA = 100_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isModifiers(v: unknown): v is Modifiers {
  if (v === undefined) return true;
  if (!isObj(v)) return false;
  for (const k of Object.keys(v)) {
    if (k !== 'alt' && k !== 'ctrl' && k !== 'meta' && k !== 'shift') return false;
    if (typeof v[k] !== 'boolean') return false;
  }
  return true;
}

function cleanModifiers(v: unknown): Modifiers | undefined {
  if (!isObj(v)) return undefined;
  const out: Modifiers = {};
  if (v.alt === true) out.alt = true;
  if (v.ctrl === true) out.ctrl = true;
  if (v.meta === true) out.meta = true;
  if (v.shift === true) out.shift = true;
  return Object.keys(out).length ? out : undefined;
}

function validTarget(v: unknown): Target | null {
  if (!isObj(v)) return null;
  if (typeof v.ref === 'string' && v.ref && typeof v.snapshotId === 'string' && v.snapshotId) {
    return { ref: v.ref, snapshotId: v.snapshotId };
  }
  if (isFiniteNum(v.x) && isFiniteNum(v.y)) {
    return { x: v.x, y: v.y };
  }
  return null;
}

const BUTTONS: ReadonlySet<string> = new Set(['left', 'right', 'middle']);
const NAMED: ReadonlySet<string> = new Set(NAMED_KEYS);

function validKey(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (NAMED.has(v)) return true;
  // A single printable character (for Ctrl+A etc.). Reject control chars.
  return [...v].length === 1 && v >= ' ';
}

/** http/https only — same policy as clip.ts safeUrl. */
function validHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (!isFiniteNum(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * Validate + normalize one untrusted verb object. Returns a clean BrowserVerb
 * or null. Never throws. Clamps oversize strings/numbers rather than rejecting,
 * except where a missing required operand makes the verb meaningless.
 */
export function validateBrowserVerb(input: unknown): BrowserVerb | null {
  if (!isObj(input) || typeof input.kind !== 'string') return null;
  const kind = input.kind;

  switch (kind) {
    case 'pointer.move': {
      const target = validTarget(input.target);
      return target ? { kind, target } : null;
    }
    case 'pointer.click': {
      const target = validTarget(input.target);
      if (!target) return null;
      const button = BUTTONS.has(input.button as string) ? (input.button as MouseButton) : 'left';
      const clickCount = (input.clickCount === 2 || input.clickCount === 3 ? input.clickCount : 1) as 1 | 2 | 3;
      const v: PointerClickVerb = { kind, target, button, clickCount };
      const mods = cleanModifiers(input.modifiers);
      if (mods) v.modifiers = mods;
      return v;
    }
    case 'pointer.down':
    case 'pointer.up': {
      const target = validTarget(input.target);
      if (!target) return null;
      const button = BUTTONS.has(input.button as string) ? (input.button as MouseButton) : 'left';
      return { kind, target, button } as PointerDownVerb | PointerUpVerb;
    }
    case 'pointer.drag': {
      const from = validTarget(input.from);
      const to = validTarget(input.to);
      if (!from || !to) return null;
      const v: PointerDragVerb = { kind, from, to };
      if (isFiniteNum(input.steps)) v.steps = clampInt(input.steps, 1, MAX_DRAG_STEPS, 10);
      const mods = cleanModifiers(input.modifiers);
      if (mods) v.modifiers = mods;
      return v;
    }
    case 'scroll.wheel': {
      const target = validTarget(input.target);
      if (!target) return null;
      const dx = isFiniteNum(input.dx) ? Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, input.dx)) : 0;
      const dy = isFiniteNum(input.dy) ? Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, input.dy)) : 0;
      if (dx === 0 && dy === 0) return null;
      const v: ScrollWheelVerb = { kind, target, dx, dy };
      const mods = cleanModifiers(input.modifiers);
      if (mods) v.modifiers = mods;
      return v;
    }
    case 'scroll.intoView':
    case 'element.focus': {
      if (typeof input.ref !== 'string' || !input.ref) return null;
      if (typeof input.snapshotId !== 'string' || !input.snapshotId) return null;
      return { kind, ref: input.ref, snapshotId: input.snapshotId } as ScrollIntoViewVerb | ElementFocusVerb;
    }
    case 'key.press': {
      if (!validKey(input.key)) return null;
      const v: KeyPressVerb = { kind, key: input.key as string };
      const mods = cleanModifiers(input.modifiers);
      if (mods) v.modifiers = mods;
      if (isFiniteNum(input.count)) v.count = clampInt(input.count, 1, MAX_KEY_COUNT, 1);
      return v;
    }
    case 'key.type': {
      if (typeof input.text !== 'string' || !input.text) return null;
      const v: KeyTypeVerb = { kind, text: input.text.slice(0, MAX_TYPE_TEXT) };
      if (input.mode === 'keys' || input.mode === 'insert') v.mode = input.mode;
      return v;
    }
    case 'form.setValue': {
      if (typeof input.ref !== 'string' || !input.ref) return null;
      if (typeof input.snapshotId !== 'string' || !input.snapshotId) return null;
      if (typeof input.value !== 'string') return null;
      return { kind, ref: input.ref, snapshotId: input.snapshotId, value: input.value.slice(0, MAX_SET_VALUE) };
    }
    case 'form.upload': {
      if (typeof input.ref !== 'string' || !input.ref) return null;
      if (typeof input.snapshotId !== 'string' || !input.snapshotId) return null;
      if (!Array.isArray(input.paths)) return null;
      const paths = input.paths.filter((p): p is string => typeof p === 'string' && !!p).slice(0, MAX_UPLOAD_FILES);
      if (!paths.length) return null;
      return { kind, ref: input.ref, snapshotId: input.snapshotId, paths };
    }
    case 'page.read': {
      const v: PageReadVerb = { kind };
      if (input.mode === 'text' || input.mode === 'interactive') v.mode = input.mode;
      if (typeof input.filter === 'string' && input.filter) v.filter = input.filter.slice(0, MAX_FILTER);
      return v;
    }
    case 'page.find': {
      if (typeof input.query !== 'string' || !input.query) return null;
      return { kind, query: input.query.slice(0, MAX_FIND_QUERY) };
    }
    case 'page.screenshot':
      return { kind };
    case 'page.zoom': {
      if (!isFiniteNum(input.factor)) return null;
      // Chrome's zoom range is 0.25–5.
      return { kind, factor: Math.min(5, Math.max(0.25, input.factor)) };
    }
    case 'nav.goto': {
      return validHttpUrl(input.url) ? { kind, url: input.url } : null;
    }
    case 'nav.back':
    case 'nav.forward':
      return { kind };
    case 'nav.reload': {
      const v: NavReloadVerb = { kind };
      if (input.hard === true) v.hard = true;
      return v;
    }
    case 'nav.waitFor': {
      const until = input.until === 'idle' ? 'idle' : 'load';
      const v: NavWaitForVerb = { kind, until };
      if (isFiniteNum(input.timeoutMs)) v.timeoutMs = clampInt(input.timeoutMs, 0, 120_000, 10_000);
      return v;
    }
    case 'tab.open': {
      if (!validHttpUrl(input.url)) return null;
      const v: TabOpenVerb = { kind, url: input.url };
      if (input.active === true) v.active = true;
      return v;
    }
    case 'tab.close':
    case 'tab.switch':
    case 'tab.duplicate': {
      if (!isFiniteNum(input.tabId)) return null;
      return { kind, tabId: Math.round(input.tabId) } as TabCloseVerb | TabSwitchVerb | TabDuplicateVerb;
    }
    case 'tab.list':
      return { kind };
    case 'dialog.handle': {
      const v: DialogHandleVerb = { kind, accept: input.accept === true };
      if (typeof input.promptText === 'string') v.promptText = input.promptText.slice(0, MAX_PROMPT_TEXT);
      return v;
    }
    case 'touch.tap': {
      const target = validTarget(input.target);
      return target ? { kind, target } : null;
    }
    case 'touch.swipe': {
      const from = validTarget(input.from);
      const to = validTarget(input.to);
      if (!from || !to) return null;
      const v: TouchSwipeVerb = { kind, from, to };
      if (isFiniteNum(input.durationMs)) v.durationMs = clampInt(input.durationMs, 0, 10_000, 300);
      return v;
    }
    default:
      return null;
  }
}

/** True iff `s` names a real verb — used to validate workflow-step hints. */
export function isVerbKind(s: unknown): s is VerbKind {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(VERB_CLASS, s);
}

/** Every verb kind, for tool descriptions and hint validation. */
export const VERB_KINDS = Object.keys(VERB_CLASS) as VerbKind[];

// Re-export the modifier guard for callers that validate loose input.
export { isModifiers };
