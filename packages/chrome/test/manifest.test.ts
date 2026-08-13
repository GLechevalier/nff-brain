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

  it('requests EXACTLY the five warning-free permissions', () => {
    // storage   — pairing token, capture flag, allowlist, activity buffer; all
    //             must survive service-worker death and browser restart.
    // alarms    — the health heartbeat; a setInterval dies with the worker.
    // activeTab — so the popup can offer "Allow this site (<current host>)".
    // contextMenus — the capture verb.
    // scripting — dynamic registerContentScripts for per-site recorders; the
    //             script only ever reaches an origin the user granted through
    //             Chrome's own prompt at recorder-enable time. Warning-free by
    //             itself: the scary part is the host, and hosts stay optional.
    // None of these shows an install-time warning. Adding one that does is the
    // thing this test exists to stop.
    expect(new Set(manifest.permissions)).toEqual(
      new Set(['storage', 'alarms', 'activeTab', 'contextMenus', 'scripting']),
    );
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

  it('registers the options page (BYOK key entry) as a full tab', () => {
    // A popup closes on focus loss — hostile to key paste and password
    // managers; store reviewers expect credential config on an options page.
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    for (const f of ['options/options.html', 'options/options.css', 'options/main.ts']) {
      expect(fs.existsSync(path.join(root, f)), `missing ${f}`).toBe(true);
    }
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

  it('registers the Brain devtools panel — a page, not a permission', () => {
    // devtools_page adds NO install-time warning and no new permission; the
    // four-permission pin above is untouched by item 3.
    expect(manifest.devtools_page).toBe('devtools.html');
    for (const f of ['devtools/devtools.html', 'devtools/panel.html']) {
      expect(fs.existsSync(path.join(root, f)), `missing ${f}`).toBe(true);
    }
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
