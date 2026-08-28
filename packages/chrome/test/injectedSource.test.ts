// The tripwire for the ONE failure mode every CDP-injected program shares: a
// free identifier.
//
// src/snapshotScript.ts, src/cursorScript.ts and src/attentionScript.ts build
// their page-side programs by stitching functions together from `.toString()`.
// That reflects the function's CURRENT source — which in a production build is
// the MINIFIED source — so any name the function closes over from module scope
// arrives in the page as a bare, unresolvable identifier. The page throws
// `ReferenceError: <minified name> is not defined` and, because read_page is
// the first thing every agent turn does, the whole web agent dies.
//
// This has shipped twice: once as `ReferenceError: Fn is not defined`, again as
// `ReferenceError: Vo is not defined` (both were ELS_GLOBAL/SNAP_GLOBAL leaking
// out of walkPage). Neither was catchable by the sibling tests: they assert on
// the UNMINIFIED source, where the leaked name still reads `ELS_GLOBAL` and the
// text-substitution that was supposed to fix it still appears to work.
// build.mjs sets `minify: !watch`, so `npm run watch` cannot reproduce it
// either — only a real `npm run build` can.
//
// So this test builds the real thing: the same esbuild settings build.mjs uses,
// minification forced ON, evaluated to get the actual builders, then every
// program they emit is parsed and checked for identifiers that resolve to
// nothing. Anything not in BROWSER_GLOBALS fails, naming the offender.

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as vm from 'node:vm';
import * as esbuild from 'esbuild';
import { parse } from 'acorn';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

/**
 * Everything the injected programs are allowed to reach for. Deliberately a
 * positive allowlist: a denylist of "names that look minified" would pass the
 * next variant of this bug. Adding a name here means "the page really does
 * provide this" — think twice before growing it.
 */
const BROWSER_GLOBALS = new Set([
  'globalThis',
  'document',
  'window',
  'location', // buildFingerprintSource reads location.href
  'URL',
  'CSS',
  'Object',
  'Math',
  'JSON',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Promise',
  'setTimeout',
  'clearTimeout',
  'Element',
  'Date',
  'decodeURIComponent', // scrapeProfileTopCard decodes the /in/<slug> from the URL
]);

type Builders = {
  buildSnapshotSource(id: string, mode: 'interactive' | 'text'): string;
  buildResolveSource(id: string, refIndex: number): string;
  buildFingerprintSource(): string;
  buildCursorInstallerSource(): string;
  buildAttentionInstallerSource(): string;
  // Not a source builder: executeScript({func}) serializes THIS function at
  // runtime — the program under test is its minified .toString().
  scrapeProfileTopCard(inviteeSlug?: string): unknown;
};

// Mirrors build.mjs's `common` — same resolution conditions and syntax floor,
// with minify pinned on (build.mjs leaves it off under --watch).
async function loadMinifiedBuilders(): Promise<Builders> {
  const out = await esbuild.build({
    stdin: {
      contents: [
        "export { buildSnapshotSource, buildResolveSource, buildFingerprintSource } from './src/snapshotScript.js';",
        "export { buildCursorInstallerSource } from './src/cursorScript.js';",
        "export { buildAttentionInstallerSource } from './src/attentionScript.js';",
        "export { scrapeProfileTopCard } from './src/profileScrapeScript.js';",
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'injectedSource.entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'chrome116',
    format: 'iife',
    globalName: '__injected',
    conditions: ['nff-brain-source'],
    minify: true,
  });
  const code = out.outputFiles[0]!.text;
  return vm.runInNewContext(`${code};__injected`, {}) as Builders;
}

// ── free-identifier analysis ────────────────────────────────────────────────
// A small scope resolver rather than a regex: the programs are minified, so
// every heuristic ("names shorter than 3 chars", "names not in the source")
// either misses real leaks or fires on legitimate locals. Scopes are collapsed
// to FUNCTION scopes (let/const treated as var) — that over-declares, which can
// only ever hide a leak, never invent one. A test that cries wolf gets deleted.

type AcornNode = { type: string } & Record<string, any>;

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

function isNode(v: unknown): v is AcornNode {
  return typeof v === 'object' && v !== null && typeof (v as AcornNode).type === 'string';
}

function children(n: AcornNode): AcornNode[] {
  const out: AcornNode[] = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) out.push(v);
  }
  return out;
}

/** Names a binding pattern introduces (destructuring included). */
function patternNames(p: AcornNode | null | undefined, out: Set<string>): void {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.add(p.name);
      return;
    case 'ObjectPattern':
      for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      return;
    case 'ArrayPattern':
      for (const el of p.elements) patternNames(el, out);
      return;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      return;
    case 'RestElement':
      patternNames(p.argument, out);
      return;
  }
}

/** Every name bound in `fn`'s scope: its own name, params, and all declarations in `body` outside nested functions. */
function scopeBindings(fn: AcornNode, body: AcornNode[]): Set<string> {
  const names = new Set<string>();
  if (fn.id) patternNames(fn.id, names);
  for (const p of (fn.params ?? []) as AcornNode[]) patternNames(p, names);

  const visit = (n: AcornNode): void => {
    switch (n.type) {
      case 'VariableDeclarator':
        patternNames(n.id, names);
        break;
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        if (n.id) names.add(n.id.name);
        break;
      case 'CatchClause':
        patternNames(n.param, names);
        break;
    }
    if (FUNCTIONS.has(n.type)) return; // a nested function's insides are its own scope
    for (const c of children(n)) visit(c);
  };
  for (const b of body) visit(b);
  return names;
}

function bodyStatements(fn: AcornNode): AcornNode[] {
  if (fn.type === 'Program') return fn.body;
  return fn.body.type === 'BlockStatement' ? fn.body.body : [fn.body]; // concise arrow body
}

/** Identifiers referenced by `src` that no enclosing scope (nor `allowed`) binds. */
function freeIdentifiers(src: string, allowed: Set<string>): string[] {
  const ast = parse(src, { ecmaVersion: 2022 }) as unknown as AcornNode;
  const free = new Set<string>();

  const walkScope = (fn: AcornNode, outer: Set<string>[]): void => {
    const body = bodyStatements(fn);
    const chain = [scopeBindings(fn, body), ...outer];
    const bound = (name: string) => allowed.has(name) || chain.some((s) => s.has(name));

    const visit = (n: AcornNode): void => {
      if (FUNCTIONS.has(n.type)) {
        walkScope(n, chain);
        return;
      }
      switch (n.type) {
        case 'Identifier':
          if (!bound(n.name)) free.add(n.name);
          return;
        case 'MemberExpression':
          visit(n.object);
          if (n.computed) visit(n.property);
          return;
        case 'Property':
        case 'PropertyDefinition':
        case 'MethodDefinition':
          if (n.computed) visit(n.key);
          if (n.value) visit(n.value);
          return;
        case 'VariableDeclarator':
          if (n.init) visit(n.init); // n.id is a binding, not a reference
          return;
        case 'CatchClause':
          visit(n.body); // n.param is a binding
          return;
        case 'ClassDeclaration':
        case 'ClassExpression':
          if (n.superClass) visit(n.superClass);
          visit(n.body);
          return;
        case 'LabeledStatement':
          visit(n.body); // n.label is not a variable
          return;
        case 'BreakStatement':
        case 'ContinueStatement':
          return; // label only
      }
      for (const c of children(n)) visit(c);
    };
    for (const b of body) visit(b);
  };

  walkScope(ast, []);
  return [...free].sort();
}

// ── the tests ───────────────────────────────────────────────────────────────

describe('injected CDP programs (minified, as shipped)', () => {
  it('reference nothing the page does not provide', async () => {
    const b = await loadMinifiedBuilders();
    const programs: Array<[string, string]> = [
      ['buildSnapshotSource (interactive)', b.buildSnapshotSource('s_test', 'interactive')],
      ['buildSnapshotSource (text)', b.buildSnapshotSource('s_test', 'text')],
      ['buildResolveSource', b.buildResolveSource('s_test', 0)],
      ['buildFingerprintSource', b.buildFingerprintSource()],
      ['buildCursorInstallerSource', b.buildCursorInstallerSource()],
      ['buildAttentionInstallerSource', b.buildAttentionInstallerSource()],
      // chrome.scripting.executeScript({func}) reflects the function source the
      // same way the CDP builders do — same leak class, same check.
      ['scrapeProfileTopCard (executeScript func)', `(${String(b.scrapeProfileTopCard)})()`],
      ['scrapeProfileTopCard (invitee-slug arg)', `(${String(b.scrapeProfileTopCard)})("ada-lovelace")`],
    ];
    for (const [name, src] of programs) {
      expect(
        freeIdentifiers(src, BROWSER_GLOBALS),
        `${name} leaks module-scope name(s) into the page — they will throw "ReferenceError: <name> is not defined" there`,
      ).toEqual([]);
    }
  });

  it('carries the ref globals as call-site literals, which minification cannot rename away', async () => {
    const b = await loadMinifiedBuilders();
    const snap = b.buildSnapshotSource('s_test', 'interactive');
    // The shape the parameter fix guarantees: the real key strings reach the
    // page as arguments, read in the SW at call time — never reflected out of
    // a minified function body.
    expect(snap).toContain('"__nffEls"');
    expect(snap).toContain('"__nffSnap"');
    // buildResolveSource's text substitution is safe for the opposite reason:
    // ELS_GLOBAL/SNAP_GLOBAL appear only inside a string literal there, which a
    // minifier does not touch — so the replace still finds them.
    expect(b.buildResolveSource('s_test', 0)).not.toMatch(/\bELS_GLOBAL\b|\bSNAP_GLOBAL\b/);
  });
});
