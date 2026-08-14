// Shared fixture-page instrumentation — the ONE script every fixture page
// loads. Records DOM events with capture-phase listeners and ships them (plus
// the page-defined state() summary) to the fixture server's ledger, which is
// what scenario verify() asserts on. The harness never evaluates JS on pages;
// pages push, the oracle reads.
//
// Page contract:
//   - tag interesting elements with data-bench="name" (falls back to id/tag)
//   - optionally define window.__benchState = () => ({...}) for a state summary
//   - optionally tag scrollable containers with data-bench-scroll
(() => {
  'use strict';

  const RUN = new URLSearchParams(location.search).get('run') || '';
  const PAGE = location.pathname.split('/').pop() || 'unknown';
  const INSTANCE = Math.random().toString(16).slice(2, 10) + '-' + Date.now().toString(36);
  const t0 = performance.now();

  // Reload/back-forward oracle: a per-(page,run) load counter + the browser's
  // own navigation type for this load.
  const navEntry = performance.getEntriesByType('navigation')[0];
  const loadKey = 'benchLoads:' + PAGE + ':' + RUN;
  const loadCount = (Number(sessionStorage.getItem(loadKey)) || 0) + 1;
  sessionStorage.setItem(loadKey, String(loadCount));

  const events = [];
  let dirty = false;

  function targetName(el) {
    if (!(el instanceof Element)) return String(el && el.nodeName || 'doc').toLowerCase();
    const tagged = el.closest('[data-bench]');
    if (tagged) return tagged.getAttribute('data-bench');
    if (el.id) return '#' + el.id;
    return el.tagName.toLowerCase();
  }

  function rec(type, target, extra) {
    events.push(Object.assign({ t: Math.round(performance.now() - t0), type, target }, extra || {}));
    dirty = true;
  }

  function state() {
    try {
      return typeof window.__benchState === 'function' ? window.__benchState() : undefined;
    } catch (err) {
      return { benchStateError: String(err) };
    }
  }

  // Viewport rects of every data-bench element (CSS px) — how the harness
  // targets non-interactive elements (div/li/p never appear in the engine's
  // own snapshot, whose selector is interactive-only).
  function rects() {
    const out = {};
    for (const el of document.querySelectorAll('[data-bench]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        out[el.getAttribute('data-bench')] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    return out;
  }

  function batch() {
    return {
      run: RUN,
      page: PAGE,
      instance: INSTANCE,
      events: events.splice(0, events.length),
      state: Object.assign(
        { loadCount, navigationType: navEntry ? navEntry.type : 'unknown', url: location.href, rects: rects() },
        state() || {}
      ),
    };
  }

  function ship(useBeacon) {
    if (!dirty && !useBeacon) return;
    dirty = false;
    const body = JSON.stringify(batch());
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/bench/report', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/bench/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  let beat = 0;
  setInterval(() => {
    // Heartbeat every ~1s even with no DOM events: page state can evolve on
    // its own (media playback timers) and rects move under scrolling.
    beat += 1;
    if (beat % 5 === 0) dirty = true;
    ship(false);
  }, 200);
  addEventListener('pagehide', () => ship(true));
  // BFCache restore resumes THIS instance instead of reloading the page —
  // record it so back/forward oracles can tell a restore from a fresh load.
  addEventListener('pageshow', (e) => {
    if (e.persisted) rec('pageshow', 'window', { persisted: true });
  });
  // First beat even with no events, so verify() can read initial state.
  dirty = true;

  const mods = (e) => ({ alt: !!e.altKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey, shift: !!e.shiftKey });

  // ── discrete events ────────────────────────────────────────────────────────
  for (const type of ['pointerdown', 'pointerup']) {
    addEventListener(type, (e) => rec(type, targetName(e.target), { button: e.button, isTrusted: e.isTrusted }), true);
  }
  for (const type of ['click', 'dblclick', 'auxclick', 'contextmenu']) {
    addEventListener(
      type,
      (e) => rec(type, targetName(e.target), Object.assign({ button: e.button, detail: e.detail, isTrusted: e.isTrusted }, mods(e))),
      true
    );
  }
  for (const type of ['keydown', 'keyup']) {
    addEventListener(
      type,
      (e) => rec(type, targetName(e.target), Object.assign({ key: e.key, code: e.code, isTrusted: e.isTrusted }, mods(e))),
      true
    );
  }
  addEventListener('input', (e) => {
    const el = e.target;
    rec('input', targetName(el), {
      inputType: e.inputType || '',
      value: typeof el.value === 'string' ? el.value.slice(0, 200) : undefined,
      isTrusted: e.isTrusted,
    });
  }, true);
  addEventListener('change', (e) => {
    const el = e.target;
    rec('change', targetName(el), {
      value: typeof el.value === 'string' ? el.value.slice(0, 200) : undefined,
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
    });
  }, true);
  addEventListener('focusin', (e) => rec('focusin', targetName(e.target)), true);
  addEventListener('focusout', (e) => rec('focusout', targetName(e.target)), true);
  addEventListener('submit', (e) => {
    e.preventDefault(); // fixture pages never really navigate on submit
    rec('submit', targetName(e.target));
  }, true);
  addEventListener('reset', (e) => rec('reset', targetName(e.target)), true);
  for (const type of ['dragstart', 'drop', 'dragend']) {
    addEventListener(type, (e) => rec(type, targetName(e.target), { isTrusted: e.isTrusted }), true);
  }
  for (const type of ['copy', 'cut', 'paste']) {
    addEventListener(type, (e) => rec(type, targetName(e.target), { isTrusted: e.isTrusted }), true);
  }
  addEventListener('hashchange', () => rec('hashchange', 'window', { hash: location.hash }));
  addEventListener('visibilitychange', () => rec('visibilitychange', 'doc', { state: document.visibilityState }));

  // ── coalesced events (high-frequency — record aggregates) ──────────────────
  let wheelAgg = null;
  addEventListener('wheel', (e) => {
    const m = mods(e);
    if (!wheelAgg) {
      wheelAgg = { target: targetName(e.target), dx: 0, dy: 0, n: 0, mods: m };
      setTimeout(() => {
        rec('wheel', wheelAgg.target, {
          dx: Math.round(wheelAgg.dx), dy: Math.round(wheelAgg.dy), n: wheelAgg.n,
          alt: wheelAgg.mods.alt, ctrl: wheelAgg.mods.ctrl, meta: wheelAgg.mods.meta, shift: wheelAgg.mods.shift,
        });
        wheelAgg = null;
      }, 300);
    }
    wheelAgg.dx += e.deltaX; wheelAgg.dy += e.deltaY; wheelAgg.n += 1;
    wheelAgg.mods = m; // last-seen modifiers
  }, { capture: true, passive: true });

  let scrollTimer = null;
  function scrollSnapshot() {
    const containers = {};
    for (const el of document.querySelectorAll('[data-bench-scroll]')) {
      containers[el.getAttribute('data-bench') || '#' + el.id] = { top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft) };
    }
    rec('scroll', 'window', { x: Math.round(scrollX), y: Math.round(scrollY), containers });
  }
  addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(scrollSnapshot, 250);
  }, { capture: true, passive: true });

  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = document.getSelection();
      rec('selection', 'doc', { text: sel ? String(sel).slice(0, 200) : '' });
    }, 300);
  });
})();
