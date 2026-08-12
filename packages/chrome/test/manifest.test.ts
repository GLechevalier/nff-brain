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

  it('requests EXACTLY the four warning-free permissions', () => {
    // storage   — pairing token, capture flag, allowlist, activity buffer; all
    //             must survive service-worker death and browser restart.
    // alarms    — the health heartbeat; a setInterval dies with the worker.
    // activeTab — so the popup can offer "Allow this site (<current host>)".
    // contextMenus — the capture verb.
    // None of these shows an install-time warning. Adding one that does is the
    // thing this test exists to stop.
    expect(new Set(manifest.permissions)).toEqual(new Set(['storage', 'alarms', 'activeTab', 'contextMenus']));
  });

  it('declares NO host_permissions', () => {
    // Load-bearing: the extension reaches 127.0.0.1 as an ordinary CORS request
    // that our own server answers. `host_permissions` would be the bypass, and
    // it costs "Read and change your data on 127.0.0.1" at install time.
    expect(manifest.host_permissions).toBeUndefined();
  });

  it('keeps the loopback host permission OPTIONAL, requested only on demand', () => {
    // The escape hatch if Chrome's local-network rules tighten. Declared, never
    // requested at install, so the install dialog stays warning-free.
    expect(manifest.optional_host_permissions).toEqual(['http://127.0.0.1/*']);
  });

  it('ships no content scripts', () => {
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('locks the CSP down and confines network access to loopback', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/object-src 'self'/);
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/unsafe-inline/);
    // Chrome itself then enforces "zero network calls off-device" — the
    // acceptance criterion becomes a platform guarantee, not a promise.
    expect(csp).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:\*/);
    expect(csp).not.toMatch(/localhost/); // dual-stack; can resolve to ::1
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
