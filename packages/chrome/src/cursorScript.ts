// The virtual agent cursor, as ONE self-contained function so it has a single
// source of truth across two very different execution contexts:
//
//   1. content/virtualCursor.ts (the LinkedIn recorder-agent content script)
//      imports createCursorController(document) and drives it directly.
//   2. src/actEngine.ts injects the SAME code into a page via CDP by evaluating
//      buildCursorInstallerSource() in the debugger's isolated world, then
//      calls the installed controller per action.
//
// Because path 2 serializes the function with .toString() and runs it in the
// page, createCursorController MUST be fully self-contained: every constant and
// helper is declared INSIDE it, and it references nothing from module scope.
// A test asserts the built source is self-contained (no bare identifier leaks).
//
// No chrome.*, no node:*, no module-level mutable state — only `const`/function
// declarations at the top level, so it satisfies both the content-script purity
// rules and the SW no-module-state rule.

/** The controller a caller uses to move/press/hide the overlay. */
export interface CursorController {
  /** Fade the overlay in (idempotent). */
  show(): void;
  /** Show the overlay pulsing at a fixed idle anchor (top-right corner) — used
   *  at run start so the agent reads as alive before its first real move. */
  showIdle(): void;
  /** Glide the dot to a viewport point; resolves when the glide finishes. */
  moveTo(x: number, y: number): Promise<void>;
  /** Play the press pulse in place; resolves when it finishes. */
  press(): Promise<void>;
  /** Glide through a path of viewport points (drag visualization). */
  dragPath(points: Array<{ x: number; y: number }>): Promise<void>;
  /** Fade the overlay out. Safe even if never shown. */
  hide(): void;
}

/**
 * Build (or reuse) the single overlay in `doc` and return a controller for it.
 * Idempotent: repeated calls reuse the one host element — the fix for the
 * original closed-shadow-root bug, where `host.shadowRoot` was always null so
 * every call stacked a new host and hide() could never find the dot.
 */
export function createCursorController(doc: Document): CursorController {
  var HOST_ID = 'nff-brain-agent-cursor';
  var ACCENT = '#00ffcc'; // same accent as devtools/panel.css's wordmark/active-tab
  var SIZE = 26; // rendered arrow icon size, viewBox units scale from a 24x24 source
  // The arrow's TIP (its hotspot — the point that represents the actual x,y)
  // sits near (3,3) in the 24-unit viewBox, not the icon's center — same
  // convention as a real OS pointer, where the click lands at the tip, not
  // the middle of the glyph.
  var TIP = (3 / 24) * SIZE;
  var TRAVEL_MS = 350;
  var PRESS_MS = 180;
  var IDLE_MARGIN = 32; // px from the top-right corner — the closest in-page proxy to the extension's toolbar icon, which is outside the DOM entirely

  function wait(ms: number): Promise<void> {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function build(): HTMLElement {
    var existing = doc.getElementById(HOST_ID);
    // mode:'open' (not 'closed') so a later call can re-find the shadow root and
    // reuse the single existing overlay instead of stacking a duplicate host.
    if (existing && existing.shadowRoot) {
      var found = existing.shadowRoot.getElementById('cursor');
      if (found) return found;
    }
    var host = existing || doc.createElement('div');
    if (!existing) {
      host.id = HOST_ID;
      host.setAttribute(
        'style',
        'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;',
      );
      (doc.documentElement || doc.body).appendChild(host);
    }
    var root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    var style = doc.createElement('style');
    style.textContent =
      '.cursor{position:fixed;top:0;left:0;display:flex;align-items:flex-start;gap:6px;' +
      'pointer-events:none;transform:translate3d(-9999px,-9999px,0);' +
      'transition:transform ' +
      TRAVEL_MS +
      'ms ease,opacity 200ms ease;opacity:0}' +
      '.cursor.visible{opacity:1}' +
      '.cursor.pressed .pointer{transform:scale(0.85)}' +
      '.cursor.idle .pointer{animation:nffCursorBreathe 1.6s ease-in-out infinite}' +
      '@keyframes nffCursorBreathe{' +
      '0%,100%{filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45)) drop-shadow(0 0 0 rgba(0,255,204,0))}' +
      '50%{filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45)) drop-shadow(0 0 5px ' +
      ACCENT +
      ')}}' +
      '.pointer{width:' +
      SIZE +
      'px;height:' +
      SIZE +
      'px;flex:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));' +
      'transition:transform 150ms ease,filter 150ms ease}' +
      '.pointer path{fill:#fff;stroke:#0a0a0a;stroke-width:1.5;stroke-linejoin:round}' +
      '.label{margin-top:' +
      (TIP + 2) +
      'px;font:600 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#0a0a0a;' +
      'background:' +
      ACCENT +
      ';padding:3px 7px;border-radius:999px;white-space:nowrap}';
    var cursor = doc.createElement('div');
    cursor.id = 'cursor';
    cursor.className = 'cursor';
    // A real arrow-pointer glyph (the same shape as Feather/Lucide's
    // "mouse-pointer" icon), not a dot — the tip at ~(3,3) in this 24-unit
    // viewBox is the hotspot moveEl() aligns to x,y, exactly like a real OS
    // cursor's click point is its tip, not its visual center.
    cursor.innerHTML =
      '<svg class="pointer" viewBox="0 0 24 24"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>' +
      '<span class="label">nff-brain agent</span>';
    root.append(style, cursor);
    return cursor;
  }

  function moveEl(el: HTMLElement, x: number, y: number): void {
    el.style.transform = 'translate3d(' + (x - TIP) + 'px,' + (y - TIP) + 'px,0)';
  }

  return {
    show: function () {
      build().classList.add('visible');
    },
    showIdle: function () {
      var el = build();
      el.classList.add('visible');
      el.classList.add('idle');
      var view = doc.defaultView;
      var w = (view && view.innerWidth) || doc.documentElement.clientWidth || 800;
      moveEl(el, w - IDLE_MARGIN, IDLE_MARGIN);
    },
    moveTo: function (x: number, y: number) {
      var el = build();
      el.classList.remove('idle');
      el.classList.add('visible');
      moveEl(el, x, y);
      return wait(TRAVEL_MS);
    },
    press: async function () {
      var el = build();
      el.classList.add('pressed');
      await wait(PRESS_MS);
      el.classList.remove('pressed');
    },
    dragPath: async function (points: Array<{ x: number; y: number }>) {
      var el = build();
      el.classList.remove('idle');
      el.classList.add('visible');
      for (var i = 0; i < points.length; i++) {
        moveEl(el, points[i]!.x, points[i]!.y);
        await wait(Math.max(60, Math.round(TRAVEL_MS / Math.max(1, points.length))));
      }
    },
    hide: function () {
      var existing = doc.getElementById(HOST_ID);
      var el = existing && existing.shadowRoot ? existing.shadowRoot.getElementById('cursor') : null;
      if (el) el.classList.remove('visible');
    },
  };
}

/** Global the injected controller is stashed under in the page's isolated world. */
export const CURSOR_GLOBAL = '__nffAgentCursor';

/**
 * The program src/actEngine.ts evaluates once per isolated world (CDP
 * Runtime.evaluate): it installs `globalThis.__nffAgentCursor` = a controller
 * over the page document. Subsequent per-action calls evaluate e.g.
 * `__nffAgentCursor.moveTo(120,340)`. Self-contained because
 * createCursorController is — .toString() carries its whole body.
 */
export function buildCursorInstallerSource(): string {
  return (
    'globalThis.' +
    CURSOR_GLOBAL +
    ' = globalThis.' +
    CURSOR_GLOBAL +
    ' || (' +
    createCursorController.toString() +
    ')(document);'
  );
}
