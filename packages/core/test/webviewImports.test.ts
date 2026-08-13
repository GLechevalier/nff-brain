import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The webview is bundled as a BROWSER IIFE. Importing the core barrel pulls
// node:fs / node:child_process and breaks that bundle at runtime, not at build
// time — so it fails in a way tests would otherwise never catch. Until now this
// rule lived only in a comment at the top of App.tsx; adding vector.ts and
// rank.ts to the allowlist makes it much easier to violate by accident.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBVIEW = path.resolve(HERE, '../../vscode/webview');
// activity.ts is the pure half of the activity pair (activityStore.ts holds the
// fs side) and was already a deliberate webview import before this change.
const ALLOWED = new Set([
  '@nff-brain/core/score',
  '@nff-brain/core/vector',
  '@nff-brain/core/rank',
  '@nff-brain/core/activity',
  '@nff-brain/core/layout',
  '@nff-brain/core/spine',
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('webview bundle purity', () => {
  const files = sources(WEBVIEW);

  it('finds the webview sources', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [path.relative(WEBVIEW, f), f]))(
    '%s imports only the browser-safe core subpaths',
    (_rel, file) => {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'(@nff-brain\/core[^']*)'/g)) {
        expect(ALLOWED, `${m[1]} is not browser-safe`).toContain(m[1]!);
      }
    },
  );

  it.each(files.map((f) => [path.relative(WEBVIEW, f), f]))(
    '%s does not import a node: builtin',
    (_rel, file) => {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/from\s+'node:/);
    },
  );
});

describe('browser-safe core modules', () => {
  const CORE = path.resolve(HERE, '../src');

  it.each([
    'score.ts',
    'vector.ts',
    'rank.ts',
    'layout.ts',
    'spine.ts',
    // Standalone-brain subpaths (Chrome extension): these plus their pure deps
    // must stay node-free or the extension bundle breaks at runtime.
    'types.ts',
    'brainGraph.ts',
    'clip.ts',
    'clipDistill.ts',
    'clipApply.ts',
    'chatPrompt.ts',
    'jsonExtract.ts',
    'promptMarkers.ts',
    'provider.ts',
    // Web-agent action/perception contract — imported by the SW engine and the
    // (future) replay/recorder pipeline; must stay node-free like the rest.
    'browserVerbs.ts',
    'pageSnapshot.ts',
    'trace.ts',
    'traceCompact.ts',
    'workflow.ts',
    'workflowDistill.ts',
    'workflowApply.ts',
  ])(
    '%s has no node: imports',
    (name) => {
      const src = fs.readFileSync(path.join(CORE, name), 'utf8');
      expect(src).not.toMatch(/from\s+'node:/);
      expect(src).not.toMatch(/\brequire\(/);
    },
  );

  it('rank.ts imports only score.ts and vector.ts', () => {
    const src = fs.readFileSync(path.join(CORE, 'rank.ts'), 'utf8');
    const imports = [...src.matchAll(/from\s+'(\.[^']*)'/g)].map((m) => m[1]!);
    expect(new Set(imports)).toEqual(new Set(['./score.js', './vector.js']));
  });

  it('vector.ts imports nothing at all', () => {
    expect(fs.readFileSync(path.join(CORE, 'vector.ts'), 'utf8')).not.toMatch(/^import\s/m);
  });
});
