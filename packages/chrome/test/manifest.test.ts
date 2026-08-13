import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// THE PERMISSION TRIPWIRE — the highest-value test in this package.
//
// "Passes review with the narrowest permission set that works" is an acceptance
// criterion that decays silently: someone adds `tabs` for one convenience and
// the install dialog grows a scary warning nobody notices until submission.
// Pinning the set here means widening it requires editing this file, which is a
// deliberate act with a review conversation attached.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('manifest.json', () => {
  it('is MV3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('hosts the web agent in a side panel', () => {
    // The agent drives the window's ACTIVE tab. A side panel (unlike DevTools)
    // does not consume that tab's debugger slot, so chrome.debugger.attach
    // succeeds and the cursor moves in the very page the user is viewing.
    // `sidePanel` is a warning-free permission.
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(manifest.permissions).toContain('sidePanel');
  });

  it('requests EXACTLY the five warning-free permissions plus debugger + tabs + sidePanel', () => {
    // storage   — pairing token, capture flag, allowlist, activity buffer; all
    //             must survive service-worker death and browser restart.
    // alarms    — the health heartbeat; a setInterval dies with the worker.
    // activeTab — so the popup can offer "Allow this site (<current host>)".
    // contextMenus — the capture verb.
    // scripting — dynamic registerContentScripts for per-site recorders; the
    //             script only ever reaches an origin the user granted through
    //             Chrome's own prompt at recorder-enable time. Warning-free by
    //             itself: the scary part is the host, and hosts stay optional.
    // debugger  — REQUIRED (see next test): Chrome forbids `debugger` in
    //             optional_permissions, so the CDP web agent can only work with
    //             it declared here.
    // tabs      — the web agent runs on the DevTools-inspected tab, and the SW
    //             must read that tab's URL (to refuse chrome:// pages and to gate
    //             actions per origin). Without `tabs`, chrome.tabs.get(tabId).url
    //             is undefined for a tab the extension has no host grant for.
    //             Strictly less exposure than the `debugger` it accompanies.
    // sidePanel — hosts the agent UI beside the active tab (warning-free).
    // debugger + tabs are the install-time warnings the web-agent feature
    // accepts; adding any OTHER warning-bearing permission is what this stops.
    expect(new Set(manifest.permissions)).toEqual(
      new Set(['storage', 'alarms', 'activeTab', 'contextMenus', 'scripting', 'debugger', 'tabs', 'sidePanel']),
    );
  });

  it('declares debugger as REQUIRED, never optional (Chrome forbids optional debugger)', () => {
    // The CDP action engine drives real trusted input via chrome.debugger.
    // Chrome does NOT allow `debugger` in optional_permissions —
    // chrome.permissions.request(['debugger']) always fails — so it MUST be a
    // required permission. That costs one install-time warning ("Access the
    // page debugger backend") and makes Chrome show its "…is debugging this
    // browser" infobar while the agent runs (a feature: the user can always see
    // and cancel it via the bar). For an unpacked load the permission is
    // auto-granted, so no runtime prompt is involved at all.
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.permissions).toContain('debugger');
  });

  it('declares NO host_permissions', () => {
    // Load-bearing: the extension reaches 127.0.0.1 as an ordinary CORS request
    // that our own server answers. `host_permissions` would be the bypass, and
    // it costs "Read and change your data on 127.0.0.1" at install time.
    expect(manifest.host_permissions).toBeUndefined();
  });

  it('keeps every host permission OPTIONAL, requested only on demand', () => {
    // Loopback: the escape hatch if Chrome's local-network rules tighten.
    // github/linkedin: one per recorder adapter, requested only when the user
    // flips that recorder on and RELEASED again on disable. Declared, never
    // requested at install, so the install dialog stays warning-free.
    expect(manifest.optional_host_permissions).toEqual([
      'http://127.0.0.1/*',
      'https://github.com/*',
      'https://www.linkedin.com/*',
    ]);
  });

  it('ships no STATIC content scripts', () => {
    // Recorders inject via chrome.scripting.registerContentScripts, gated on a
    // granted optional host — a site with no enabled recorder never runs any
    // extension code. A static content_scripts entry would break exactly that.
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('ships no web-accessible resources', () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('locks the CSP down: loopback + the user-keyed provider host, nothing else', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/localhost/); // dual-stack; can resolve to ::1
    // Pinned as the FULL string now that it is a compound claim: Chrome
    // enforces that requests reach loopback or api.anthropic.com and nowhere
    // else. Adding a provider host is a deliberate act with a privacy-policy
    // edit attached (store/privacy-policy.md and bundlePurity's
    // PROVIDER_API_URLS must move in the same commit).
    expect(csp).toBe(
      "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* https://api.anthropic.com",
    );
  });

  it('refuses to run in incognito', () => {
    // A memory tool silently recording incognito browsing is a landmine, and
    // opting out removes an entire reviewer concern for free.
    expect(manifest.incognito).toBe('not_allowed');
  });

  it('points at the built service worker and popup', () => {
    expect(manifest.background.service_worker).toBe('sw.js');
    // Classic worker, not a module: esbuild emits one self-contained IIFE.
    expect(manifest.background.type).toBeUndefined();
    expect(manifest.action.default_popup).toBe('popup.html');
  });

  it('ships every icon size it declares', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toBe(`icons/${size}.png`);
      const file = path.join(root, 'icons', `${size}.png`);
      expect(fs.existsSync(file), `missing ${file}`).toBe(true);
      // A zero-byte placeholder passes existsSync and fails store review.
      expect(fs.statSync(file).size).toBeGreaterThan(100);
      expect(fs.readFileSync(file).subarray(1, 4).toString('ascii')).toBe('PNG');
    }
  });
});

describe('test-manifest variant (NFF_BRAIN_TEST_MANIFEST=1)', () => {
  // The eval harness loads dist/ unpacked with install-time grants, because
  // Chrome's native optional-permission prompt cannot be automated. The
  // variant may differ from the production manifest in EXACTLY two ways —
  // host_permissions appears (= the optional_host_permissions array) and
  // optional_permissions fold into permissions. Anything else drifting
  // between the two manifests would mean the eval fleet no longer tests the
  // extension we ship. zip.mjs refuses to package a dist that has
  // host_permissions, so the variant cannot reach the store.
  it('when dist/ holds the variant, it differs from manifest.json in exactly the promoted keys', () => {
    const distManifestPath = path.join(root, 'dist', 'manifest.json');
    if (!fs.existsSync(distManifestPath)) return; // unbuilt workspace — skip, like bundlePurity's dist suite
    const dist = JSON.parse(fs.readFileSync(distManifestPath, 'utf8'));
    if (dist.host_permissions === undefined) {
      // Production build — dist must be byte-equivalent JSON to the source.
      expect(dist).toEqual(manifest);
      return;
    }
    const expected = {
      ...manifest,
      host_permissions: manifest.optional_host_permissions,
      permissions: [...manifest.permissions, ...(manifest.optional_permissions ?? [])],
    };
    expect(dist).toEqual(expected);
  });
});
