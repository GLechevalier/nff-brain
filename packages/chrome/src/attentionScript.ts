// The persistent "nff-brain is active in this tab" indicator: a pulsing teal
// glow border plus a bottom-center Stop pill, shown for the duration of a CDP
// web-agent run (src/actRun.ts). Same self-contained-function discipline as
// cursorScript.ts, and for the same reason — src/actEngine.ts evaluates
// buildAttentionInstallerSource() in the page via CDP Runtime.evaluate, so
// createAttentionController MUST carry its whole body with it (.toString()),
// referencing nothing from module scope.
//
// A CDP-evaluated script runs in the page's MAIN WORLD (the same world the page
// itself runs in), not an isolated content-script world, so it has no chrome.*
// access — the Stop button cannot message the service worker directly the way
// a real content script could. Instead a click just sets stopRequested on the
// controller; actRun.ts's keepGoing() polls it (consumeStop(), also via CDP
// evaluate) at the same between-turns checkpoint it already uses for the
// storage-based Stop, so a page click and a panel Stop click resolve on the
// same cadence. This trades a little latency for staying on the extension's
// existing zero-extra-permission channel — the CDP web agent deliberately
// holds no host permissions for arbitrary origins.

/** The controller a caller uses to show/hide the overlay and read the Stop click. */
export interface AttentionController {
  /** Fade the border+pill in (idempotent; never clears a pending stop request)
   *  AND badge the browser tab strip (favicon + title prefix). */
  show(): void;
  /** Fade the border+pill out and restore the tab strip's real favicon/title. Safe even if never shown. */
  hide(): void;
  /** Read and clear the Stop-button flag in one step. */
  consumeStop(): boolean;
}

/**
 * Build (or reuse) the single overlay in `doc` and return a controller for it.
 * Idempotent like cursorScript.ts's createCursorController: a later call in the
 * SAME document reuses the one host element and its stopRequested state, so a
 * mid-run reinstall (actEngine.ts calls this before every interact verb, same
 * as the cursor) never resets a pending Stop click nor stacks a duplicate host.
 * A NAVIGATION, however, tears down the whole document — the next reinstall
 * naturally builds a fresh instance there, which is the desired reset.
 */
export function createAttentionController(doc: Document): AttentionController {
  var HOST_ID = 'nff-brain-agent-attention';
  var ACCENT = '#00ffcc';
  var state = { stopRequested: false };

  // ── tab-strip badge (favicon + title prefix) ────────────────────────────
  // Chrome has no extension API to badge an arbitrary tab's icon/title in the
  // strip — favicon/title are plain page DOM (`<link rel="icon">`,
  // document.title), so this rides the SAME CDP main-world injection as
  // everything else here, with the same no-new-permissions trade-off. A page
  // with a strict `img-src` CSP may silently reject the data: favicon; the
  // title prefix is unaffected (CSP never governs document.title).
  var FAVICON_ID = 'nff-brain-agent-favicon';
  var TITLE_PREFIX = '● '; // '● ' — short on purpose, keeps the real title legible in a narrow tab
  // The nff-brain capybara mascot (packages/chrome/icons/32.png), inlined as
  // base64 rather than referenced by chrome-extension://<id>/... — this code
  // runs in the PAGE's main world via CDP, which has no chrome.* access to
  // resolve the extension's own id/URL, and self-containment (.toString()
  // carries the whole function body with it) is the same discipline every
  // other asset in this file already follows.
  var FAVICON_HREF =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAArUlEQVR42u2W0QnAIAxEXa//3aEjdJwu1l1aKAQ01cboRSnkIF9C7ulJNASXy/UDXYX6WseZ79vy1HmsSZEZrVMhAZLGHIAXGiBuVg2AjEANEMUSoADSHZgGMPQEaszNILQAcAieswIAO5BmnkITABKiyRwJMRWgyxwB8Zr3pXfAAiBpTINJa94NwJ5ZtXkXQOaXM2z3YiSW2YuRSI+UxSjOfj4LpnBjzR1xqXUDcF0fYAM3T68AAAAASUVORK5CYII=';
  // null until badged; holds exactly what's needed to restore the page's real
  // favicon/title on hide(). Kept separate from `state` above so a repeated
  // show() (the existing per-interact-verb reinstall) can check "already
  // badged?" without touching the unrelated Stop-click flag.
  var savedBadge: { title: string; links: Element[] } | null = null;

  function badgeTab(): void {
    if (savedBadge) return; // already badged — never re-capture our own prefixed title as "original"
    var head = doc.head;
    if (!head) return;
    var existing = doc.querySelectorAll('link[rel~="icon"]');
    var links: Element[] = [];
    for (var i = 0; i < existing.length; i++) links.push(existing[i]!);
    savedBadge = { title: doc.title, links: links };
    for (var j = 0; j < links.length; j++) {
      var l = links[j]!;
      if (l.parentNode) l.parentNode.removeChild(l);
    }
    var icon = doc.createElement('link');
    icon.id = FAVICON_ID;
    icon.setAttribute('rel', 'icon');
    icon.setAttribute('href', FAVICON_HREF);
    head.appendChild(icon);
    doc.title = TITLE_PREFIX + doc.title;
  }

  function unbadgeTab(): void {
    if (!savedBadge) return;
    var head = doc.head;
    var injected = doc.getElementById(FAVICON_ID);
    if (injected && injected.parentNode) injected.parentNode.removeChild(injected);
    if (head) {
      for (var i = 0; i < savedBadge.links.length; i++) head.appendChild(savedBadge.links[i]!);
    }
    doc.title = savedBadge.title;
    savedBadge = null;
  }

  function build(): { glow: HTMLElement; pill: HTMLElement } {
    var existing = doc.getElementById(HOST_ID);
    // mode:'open' (not 'closed') so a later call can re-find the shadow root —
    // same fix cursorScript.ts's host reuse relies on.
    if (existing && existing.shadowRoot) {
      var foundGlow = existing.shadowRoot.getElementById('nff-attn-glow');
      var foundPill = existing.shadowRoot.getElementById('nff-attn-pill');
      if (foundGlow && foundPill) return { glow: foundGlow, pill: foundPill };
    }
    var host = existing || doc.createElement('div');
    if (!existing) {
      host.id = HOST_ID;
      host.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;');
      (doc.documentElement || doc.body).appendChild(host);
    }
    var root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    var style = doc.createElement('style');
    style.textContent =
      '.glow{position:fixed;inset:0;pointer-events:none;opacity:0;' +
      'transition:opacity 300ms ease-in-out;z-index:2147483646}' +
      '.glow.visible{opacity:1}' +
      '.glow-inner{position:absolute;inset:0;box-shadow:' +
      'inset 0 0 15px rgba(0,255,204,0.7),inset 0 0 25px rgba(0,255,204,0.5),' +
      'inset 0 0 35px rgba(0,255,204,0.2);animation:nffAttnPulse 2s ease-in-out infinite}' +
      '@keyframes nffAttnPulse{0%,100%{opacity:.6}50%{opacity:1}}' +
      '@media (prefers-reduced-motion: reduce){.glow-inner{animation:none}}' +
      '.pill{position:fixed;bottom:16px;left:50%;pointer-events:auto;' +
      'transform:translateX(-50%) translateY(12px);display:flex;align-items:center;gap:8px;' +
      'padding:8px 10px 8px 14px;border-radius:999px;background:#0a0a0a;' +
      'border:1px solid rgba(0,255,204,0.4);box-shadow:0 8px 24px rgba(0,255,204,0.18);' +
      'opacity:0;transition:opacity 200ms ease,transform 200ms ease;z-index:2147483647;' +
      'font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#f4fffb}' +
      '.pill.visible{opacity:1;transform:translateX(-50%) translateY(0)}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:' +
      ACCENT +
      ';box-shadow:0 0 6px 1px rgba(0,255,204,0.7);flex:none}' +
      '.label{white-space:nowrap}' +
      '.stop{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;' +
      'background:' +
      ACCENT +
      ';color:#0a0a0a;font-weight:700}' +
      '.stop[disabled]{opacity:.5;cursor:default}';

    var glow = doc.createElement('div');
    glow.id = 'nff-attn-glow';
    glow.className = 'glow';
    glow.innerHTML = '<div class="glow-inner"></div>';

    var pill = doc.createElement('div');
    pill.id = 'nff-attn-pill';
    pill.className = 'pill';
    pill.innerHTML =
      '<span class="dot"></span>' +
      '<span class="label">nff-brain is active in this tab</span>' +
      '<button class="stop" type="button">Stop</button>';

    var button = pill.querySelector('.stop') as HTMLButtonElement | null;
    var label = pill.querySelector('.label') as HTMLElement | null;
    if (button) {
      button.addEventListener('click', function () {
        state.stopRequested = true;
        button!.setAttribute('disabled', 'true');
        if (label) label.textContent = 'stopping…';
      });
    }

    root.append(style, glow, pill);
    return { glow: glow, pill: pill };
  }

  return {
    show: function () {
      var els = build();
      els.glow.classList.add('visible');
      els.pill.classList.add('visible');
      badgeTab();
    },
    hide: function () {
      var existing = doc.getElementById(HOST_ID);
      var root = existing && existing.shadowRoot;
      var glow = root ? root.getElementById('nff-attn-glow') : null;
      var pill = root ? root.getElementById('nff-attn-pill') : null;
      if (glow) glow.classList.remove('visible');
      if (pill) pill.classList.remove('visible');
      unbadgeTab();
    },
    consumeStop: function () {
      var v = state.stopRequested;
      state.stopRequested = false;
      return v;
    },
  };
}

/** Global the injected controller is stashed under in the page's main world. */
export const ATTENTION_GLOBAL = '__nffAgentAttention';

/**
 * The program src/actEngine.ts evaluates: installs `globalThis.__nffAgentAttention`
 * = a controller over the page document. Subsequent calls evaluate e.g.
 * `__nffAgentAttention.show()` / `.hide()` / `.consumeStop()`. Self-contained
 * because createAttentionController is — .toString() carries its whole body.
 */
export function buildAttentionInstallerSource(): string {
  return (
    'globalThis.' +
    ATTENTION_GLOBAL +
    ' = globalThis.' +
    ATTENTION_GLOBAL +
    ' || (' +
    createAttentionController.toString() +
    ')(document);'
  );
}
