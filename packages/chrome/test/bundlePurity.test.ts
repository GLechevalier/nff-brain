import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Structural guards, in the spirit of packages/core/test/webviewImports.test.ts.
// These encode invariants that are otherwise only comments — "zero network calls
// off-device", "one capture choke point", "no module-level state in the service
// worker" — as things that fail CI rather than things a reviewer must remember.
//
// Colocated here rather than in core because they assert on packages/chrome
// sources; core owns only the browser-safe-subpath contract.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function sources(): { file: string; rel: string; text: string }[] {
  const out: { file: string; rel: string; text: string }[] = [];
  for (const dir of ['src', 'popup', 'devtools', 'content', 'options']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.ts')) continue;
      const file = path.join(abs, name);
      out.push({ file, rel: `${dir}/${name}`, text: fs.readFileSync(file, 'utf8') });
    }
  }
  return out;
}

const FILES = sources();

/**
 * Strip comments before asserting on code.
 *
 * Without this these guards match their own documentation: gate.ts's header
 * literally says "no chrome.*", which a naive scan for `chrome.` happily finds.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Recorder adapters legitimately NAME their own site — match patterns in the
 * registry, URL-shape classifiers in the content scripts. Naming is not
 * calling: the content-isolation suite below proves content scripts cannot
 * fetch at all, and the manifest CSP confines every real request to loopback.
 * Exact-match only, so a new host still fails until deliberately added here.
 */
const RECORDER_SITE_URLS = new Set(['https://github.com', 'https://www.linkedin.com']);

/**
 * XML namespace identifiers are opaque spec-mandated strings, never fetched —
 * the graph canvas's document.createElementNS needs the literal SVG one. The
 * regex below stops at the first '/' after the host, same as it does for
 * every other URL here, so this is the host-only prefix, not the full URI.
 * Exact-match only, same discipline as RECORDER_SITE_URLS above.
 */
const NAMESPACE_URIS = new Set(['http://www.w3.org']);

/**
 * BYOK provider endpoints — the ONE deliberate egress class. User-key-gated
 * (nothing is sent until the user saves a key on the options page) and
 * CSP-enumerated (manifest.test.ts pins the exact connect-src). Exact-match
 * only: a new provider host fails here AND in the manifest CSP pin until
 * deliberately added to both, plus store/privacy-policy.md, in one commit.
 */
const PROVIDER_API_URLS = new Set(['https://api.anthropic.com']);

/** Absolute URL literals with a concrete host. `http://${HOST}` is fine. */
function offDeviceUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)]
    .map((m) => m[0])
    .filter(
      (u) =>
        !u.startsWith('http://127.0.0.1') &&
        !RECORDER_SITE_URLS.has(u) &&
        !NAMESPACE_URIS.has(u) &&
        !PROVIDER_API_URLS.has(u),
    );
}

describe('source purity', () => {
  it('finds the sources it means to check', () => {
    expect(FILES.length).toBeGreaterThan(8);
  });

  it.each(FILES.map((f) => f.rel))('%s imports nothing from node:', (rel) => {
    const { text } = FILES.find((f) => f.rel === rel)!;
    expect(text).not.toMatch(/from ['"]node:/);
    expect(text).not.toMatch(/\brequire\(/);
  });

  it.each(FILES.map((f) => f.rel))('%s contains no off-device URL', (rel) => {
    // ACCEPTANCE CRITERION "zero network calls off-device", as a test rather
    // than a promise. Chrome also enforces it via connect-src in the manifest.
    const { text } = FILES.find((f) => f.rel === rel)!;
    expect(offDeviceUrls(text)).toEqual([]);
  });

  it('only ever imports the browser-safe subpaths of @nff-brain/core', () => {
    // Standalone mode widened this set (types/brainGraph/clip*/chatPrompt/
    // jsonExtract carry the in-browser brain; provider carries the BYOK
    // adapters). Every entry must stay node-free — guarded by
    // packages/core/test/webviewImports.test.ts's browser-safe module rows.
    const allowed = new Set([
      'score',
      'vector',
      'rank',
      'activity',
      'types',
      'brainGraph',
      'clip',
      'clipDistill',
      'clipApply',
      'chatPrompt',
      'jsonExtract',
      'provider',
    ]);
    for (const { rel, text } of FILES) {
      for (const m of text.matchAll(/from ['"]@nff-brain\/core(?:\/([a-zA-Z]+))?['"]/g)) {
        expect(m[1], `${rel} imports the bare core barrel, which pulls in node:*`).toBeDefined();
        expect(allowed.has(m[1]!), `${rel} imports @nff-brain/core/${m[1]}`).toBe(true);
      }
    }
  });
});

describe('the capture choke point', () => {
  const gate = FILES.find((f) => f.rel === 'src/gate.ts')!;

  it('gate.ts imports only types, so it stays trivially testable', () => {
    for (const m of gate.text.matchAll(/^import .*$/gm)) {
      expect(m[0], `gate.ts has a value import: ${m[0]}`).toMatch(/^import type /);
    }
  });

  it.each(['src/gate.ts', 'src/schema.ts', 'src/health.ts', 'src/protocol.ts', 'src/agentGate.ts'])(
    '%s never touches chrome.*',
    (rel) => {
      expect(code(FILES.find((f) => f.rel === rel)!.text)).not.toMatch(/\bchrome\./);
    },
  );

  it('routes every capture decision through shouldCapture()', () => {
    // Every entry point must call the same function; a second copy of the
    // matching logic is the bug this catches. Exactly two registered callers:
    // the context menu (capture.ts) and the recorder event sink (recorder.ts).
    const callers = FILES.filter((f) => f.rel !== 'src/gate.ts' && /\bshouldCapture\(/.test(code(f.text)));
    expect(callers.map((c) => c.rel).sort()).toEqual(['src/capture.ts', 'src/recorder.ts']);
  });

  it('implements host MATCHING in exactly one file', () => {
    // The label-boundary test is the security-critical line. A second copy of
    // it anywhere is how an allowlist bypass gets introduced.
    const matchers = FILES.filter((f) => f.rel !== 'src/gate.ts' && /\bendsWith\(/.test(code(f.text)));
    expect(matchers.map((m) => m.rel)).toEqual([]);
  });

  it('reads a hostname only where it cannot grant capture', () => {
    // activity.ts labels a buffered record; main.ts labels the "Allow this
    // site" button; content/github.ts classifies a form's target (the worker
    // re-gates on sender.tab.url regardless); agentGate.ts is item 7's OWN
    // separate choke point (a different question — is DOM automation allowed
    // here — never a second copy of shouldCapture's decision). None of them
    // decides capture — gate.ts alone does that.
    const readers = FILES.filter((f) => /\.hostname\b/.test(code(f.text)));
    expect(readers.map((r) => r.rel).sort()).toEqual([
      'content/githubClassify.ts',
      'popup/main.ts',
      'src/activity.ts',
      'src/agentGate.ts',
      'src/gate.ts',
    ]);
  });

  it('reads chrome.storage from exactly one module', () => {
    const users = FILES.filter((f) => /chrome\.storage\.local\./.test(code(f.text)));
    expect(users.map((u) => u.rel).sort()).toEqual(['src/storage.ts']);
  });
});

describe('MV3 service-worker discipline', () => {
  // The worker is destroyed after ~30s idle, so module-level state silently
  // reverts to its initializer — the single hardest MV3 bug to reproduce.
  const topLevelBindings = (text: string) =>
    [...text.matchAll(/^(let|var) +([A-Za-z_$][\w$]*)/gm)].map((m) => m[2]!);

  it.each([
    'src/sw.ts',
    'src/capture.ts',
    'src/storage.ts',
    'src/badge.ts',
    'src/activity.ts',
    'src/gate.ts',
    'src/health.ts',
    'src/recorder.ts',
    'src/recorderFormat.ts',
    'src/recorderRegistry.ts',
    'src/agentRunner.ts',
    'src/agentRegistry.ts',
    'src/agentGate.ts',
    'src/providerClient.ts',
    'src/mode.ts',
    'src/standaloneDrain.ts',
    'src/standalone.ts',
    'src/migrate.ts',
  ])('%s declares no mutable module-level state', (rel) => {
    expect(topLevelBindings(FILES.find((f) => f.rel === rel)!.text)).toEqual([]);
  });

  it('permits exactly two documented module-level variables', () => {
    // connection.ts: the in-flight probe promise. brainStore.ts: the mutation
    // serialization chain. Both are harmless to lose on worker death (death
    // means nothing is in flight) and each must keep its rationale inline.
    const conn = FILES.find((f) => f.rel === 'src/connection.ts')!;
    expect(topLevelBindings(conn.text)).toEqual(['inFlightProbe']);
    expect(conn.text).toMatch(/harmless/i); // the rationale must stay next to it
    const store = FILES.find((f) => f.rel === 'src/brainStore.ts')!;
    expect(topLevelBindings(store.text)).toEqual(['mutateChain']);
    expect(store.text).toMatch(/harmless/i);
  });

  it('registers every listener synchronously at the top level of sw.ts', () => {
    // A listener registered after an await is not registered when Chrome cold
    // starts the worker to deliver that very event — the event is dropped.
    const sw = FILES.find((f) => f.rel === 'src/sw.ts')!.text;
    for (const listener of [
      'chrome.runtime.onInstalled.addListener',
      'chrome.runtime.onStartup.addListener',
      'chrome.alarms.onAlarm.addListener',
      'chrome.contextMenus.onClicked.addListener',
      'chrome.runtime.onMessage.addListener',
    ]) {
      expect(sw, `${listener} must be registered in sw.ts`).toContain(listener);
      // At column 0 — i.e. not nested inside a function or a .then().
      expect(sw).toMatch(new RegExp(`^${listener.replace(/\./g, '\\.')}`, 'm'));
    }
  });

  it('never returns a bare async function from onMessage', () => {
    // Chrome ignores a returned Promise (Firefox does not); `return true` is
    // what actually keeps the message port open.
    const sw = FILES.find((f) => f.rel === 'src/sw.ts')!.text;
    expect(sw).not.toMatch(/onMessage\.addListener\(async/);
    expect(sw).toMatch(/return true;/);
  });
});

describe('content-script isolation', () => {
  // The token-never-in-content invariant as CI, not a promise: a content
  // script runs alongside a hostile page and must hold NOTHING worth stealing.
  const contentFiles = FILES.filter((f) => f.rel.startsWith('content/'));

  it('finds the content sources it means to check', () => {
    expect(contentFiles.length).toBeGreaterThanOrEqual(3); // runtime + 2 adapters
  });

  it.each(['chrome\\.storage', 'postClip', 'nb\\.pairing', 'fetch\\(', '\\btoken\\b'])(
    'no content script ever matches /%s/',
    (pattern) => {
      const re = new RegExp(pattern);
      for (const f of contentFiles) {
        expect(re.test(code(f.text)), `${f.rel} matches ${pattern}`).toBe(false);
      }
    },
  );

  it('content scripts send only recorderEvent messages', () => {
    for (const f of contentFiles) {
      const c = code(f.text);
      if (/sendMessage/.test(c)) {
        expect(f.rel).toBe('content/runtime.ts'); // one wire, one place
        expect(c).toContain("type: 'recorderEvent'");
      }
    }
  });
});

describe('built artifacts', () => {
  const dist = path.join(root, 'dist');
  const read = (name: string) => fs.readFileSync(path.join(dist, name), 'utf8');

  it('ships manifest.json at the archive root alongside all bundles', () => {
    // Guarded like packages/cli/test/e2e.test.ts does: a missing dist means the
    // build has not run in this workspace, not that the assertion failed.
    if (!fs.existsSync(dist)) return;
    for (const f of [
      'manifest.json',
      'sw.js',
      'popup.js',
      'popup.html',
      'popup.css',
      'devtools.js',
      'devtools.html',
      'panel.js',
      'panel.html',
      'panel.css',
      'options.js',
      'options.html',
      'options.css',
      'rec-github.js',
      'rec-linkedin.js',
      'rec-linkedin-agent.js',
    ]) {
      expect(fs.existsSync(path.join(dist, f)), `dist/${f} missing`).toBe(true);
    }
  });

  it('contains no off-device URL and no framework runtime', () => {
    if (!fs.existsSync(dist)) return;
    for (const name of ['sw.js', 'popup.js', 'devtools.js', 'panel.js', 'options.js', 'rec-github.js', 'rec-linkedin.js', 'rec-linkedin-agent.js']) {
      const text = read(name);
      // This is what actually ships — it catches an egress URL arriving through
      // a dependency rather than through our own source.
      expect(offDeviceUrls(text), `dist/${name} reaches off-device`).toEqual([]);
      expect(text).not.toMatch(/react-dom/);
    }
  });
});
