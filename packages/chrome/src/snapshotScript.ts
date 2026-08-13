// The perception program the action engine injects (CDP Runtime.evaluate in a
// debugger isolated world) to read a page into a PageSnapshot. Like
// cursorScript.ts it must be SELF-CONTAINED when serialized, so the walker and
// its helpers are stitched together from their own .toString() at build time
// rather than closing over module scope.
//
// The small decision helpers (roleOf / isRedacted / nameFromParts) are exported
// and unit-tested directly — no live DOM needed for those. The DOM walk that
// calls them is covered by the manual e2e checklist, since this workspace has
// no jsdom/happy-dom.
//
// Ref model: the walker stashes the actual element objects on the page under
// globalThis.__nffEls and records the snapshot id under globalThis.__nffSnap.
// A ref "e3" is index 3 into that array, valid only while __nffSnap still
// equals the snapshot the ref came from — that is how the engine detects a
// stale ref instead of acting on whatever now sits at that position.

export const ELS_GLOBAL = '__nffEls';
export const SNAP_GLOBAL = '__nffSnap';

/** Coarse role for an element, accessibility-first then tag/type fallback. */
export function roleOf(tag: string, explicitRole: string | null, type: string | null): string {
  if (explicitRole) return explicitRole;
  var t = tag.toLowerCase();
  if (t === 'a') return 'link';
  if (t === 'button') return 'button';
  if (t === 'select') return 'combobox';
  if (t === 'textarea') return 'textbox';
  if (t === 'input') {
    var ty = (type || 'text').toLowerCase();
    if (ty === 'checkbox') return 'checkbox';
    if (ty === 'radio') return 'radio';
    if (ty === 'range') return 'slider';
    if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
    if (ty === 'password' || ty === 'email' || ty === 'tel' || ty === 'search' || ty === 'url' || ty === 'number')
      return 'textbox';
    return 'textbox';
  }
  return t;
}

/** True when an input's value must never be read into a snapshot. */
export function isRedacted(tag: string, type: string | null, autocomplete: string | null): boolean {
  if (tag.toLowerCase() !== 'input') return false;
  var ty = (type || '').toLowerCase();
  if (ty === 'password') return true;
  var ac = (autocomplete || '').toLowerCase();
  if (ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code') return true;
  if (ac.indexOf('cc-') === 0) return true; // credit-card autofill hints
  return false;
}

/** Pick the best accessible name from candidate strings, first non-empty wins, clamped. */
export function nameFromParts(parts: Array<string | null | undefined>, max: number): string {
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (typeof p === 'string') {
      var s = p.replace(/\s+/g, ' ').trim();
      if (s) return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }
  }
  return '';
}

// The DOM walker. Declared as a normal function so its .toString() can be
// stitched into the injected program AFTER the helper sources, which is why it
// references roleOf/isRedacted/nameFromParts by bare name — those names are
// defined in the same injected scope. Never called directly in the SW.
function walkPage(snapshotId: string, mode: string): unknown {
  var MAX_NAME = 80;
  var MAX_VALUE = 120;
  var MAX_ELS = 200;
  var doc = document;
  var win = window;
  var els: Element[] = [];
  var out: unknown[] = [];

  function labelFor(el: Element): string | null {
    var id = el.getAttribute('id');
    if (id) {
      var lab = doc.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (lab && lab.textContent) return lab.textContent;
    }
    var closest = el.closest && el.closest('label');
    return closest && closest.textContent ? closest.textContent : null;
  }

  var SEL =
    'a[href],button,input,select,textarea,[role],[tabindex],[contenteditable="true"],summary';
  var candidates = doc.querySelectorAll(SEL);
  for (var i = 0; i < candidates.length && els.length < MAX_ELS; i++) {
    var el = candidates[i] as HTMLElement;
    var tag = el.tagName.toLowerCase();
    var style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    var type = el.getAttribute('type');
    var role = roleOf(tag, el.getAttribute('role'), type);
    var redacted = isRedacted(tag, type, el.getAttribute('autocomplete'));
    var name = nameFromParts(
      [
        el.getAttribute('aria-label'),
        labelFor(el),
        el.getAttribute('placeholder'),
        el.getAttribute('alt'),
        el.getAttribute('title'),
        el.getAttribute('value') && tag === 'input' && (type === 'button' || type === 'submit')
          ? el.getAttribute('value')
          : null,
        tag === 'a' || tag === 'button' ? el.textContent : null,
      ],
      MAX_NAME,
    );

    var ref = 'e' + els.length;
    els.push(el);

    var rec: Record<string, unknown> = {
      ref: ref,
      role: role,
      name: name,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      inViewport: rect.top < win.innerHeight && rect.bottom > 0 && rect.left < win.innerWidth && rect.right > 0,
    };
    if (!redacted) {
      var v = (el as HTMLInputElement).value;
      if (typeof v === 'string' && v && tag !== 'button' && tag !== 'a') rec.value = v.slice(0, MAX_VALUE);
    }
    var st: Record<string, boolean> = {};
    if ((el as HTMLInputElement).checked) st.checked = true;
    if ((el as HTMLInputElement).disabled) st.disabled = true;
    if (el.getAttribute('aria-expanded') === 'true') st.expanded = true;
    if ((el as HTMLOptionElement).selected) st.selected = true;
    if (doc.activeElement === el) st.focused = true;
    if (Object.keys(st).length) rec.state = st;
    var sx = (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth;
    var sy = (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight;
    if (sy > 4 || sx > 4) rec.scrollable = { maxDx: sx > 4 ? sx : 0, maxDy: sy > 4 ? sy : 0 };
    var href = el.getAttribute('href');
    if (href && tag === 'a') {
      try {
        rec.href = new URL(href, doc.baseURI).toString();
      } catch (e) {
        /* skip bad href */
      }
    }
    out.push(rec);
  }

  (globalThis as Record<string, unknown>)[ELS_GLOBAL] = els;
  (globalThis as Record<string, unknown>)[SNAP_GLOBAL] = snapshotId;

  var snap: Record<string, unknown> = {
    snapshotId: snapshotId,
    url: doc.location ? doc.location.href : '',
    title: doc.title || '',
    viewport: {
      w: win.innerWidth,
      h: win.innerHeight,
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      pageH: doc.documentElement ? doc.documentElement.scrollHeight : 0,
    },
    elements: out,
    frames: [],
  };
  if (mode === 'text') {
    var body = doc.body ? doc.body.innerText || '' : '';
    snap.text = body.slice(0, 8000);
  }
  return snap;
}

// ELS_GLOBAL/SNAP_GLOBAL are string constants; inline their literal values into
// the walker source so the injected program has no free identifiers.
function inlineGlobals(src: string): string {
  return src.replace(/ELS_GLOBAL/g, JSON.stringify(ELS_GLOBAL)).replace(/SNAP_GLOBAL/g, JSON.stringify(SNAP_GLOBAL));
}

/** The program that reads the page and returns a snapshot (minus tabId, added by the engine). */
export function buildSnapshotSource(snapshotId: string, mode: 'interactive' | 'text'): string {
  return (
    '(function(){' +
    roleOf.toString() +
    isRedacted.toString() +
    nameFromParts.toString() +
    'var __walk=' +
    inlineGlobals(walkPage.toString()) +
    ';return __walk(' +
    JSON.stringify(snapshotId) +
    ',' +
    JSON.stringify(mode) +
    ');})()'
  );
}

/**
 * The program that resolves a ref to a viewport-center point, verifying the
 * snapshot is still current. Returns {x,y} | {stale:true} | {gone:true}.
 */
export function buildResolveSource(snapshotId: string, refIndex: number): string {
  return inlineGlobals(
    '(function(){' +
      'if(globalThis[SNAP_GLOBAL]!==' +
      JSON.stringify(snapshotId) +
      ')return {stale:true};' +
      'var els=globalThis[ELS_GLOBAL]||[];var el=els[' +
      String(refIndex) +
      '];if(!el||!el.isConnected)return {gone:true};' +
      'var r=el.getBoundingClientRect();' +
      'return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};' +
      '})()',
  );
}

/** Parse "e3" → 3, or null. */
export function refIndex(ref: string): number | null {
  var m = /^e(\d+)$/.exec(ref);
  return m ? Number(m[1]) : null;
}
