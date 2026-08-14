import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The version baked into the bundle AT BUILD TIME, with a build stamp — so
// `nff-brain serve`, /v1/hello, /v1/status and the Chrome extension's Settings
// panel all report the version of the code that is actually running. A runtime
// package.json read cannot do that: the bare "0.1.0" never changes between
// rebuilds, which is exactly how a stale dist/ once masqueraded as current
// (the "no brain listening" version-skew incident). Same idea as the chrome
// package's per-build manifest bump.
const pkgVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version;
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '.')
  .slice(0, 13); // 20260814.1042 — minute granularity is enough to tell builds apart
const buildVersion = `${pkgVersion}+${stamp}`;

export default defineConfig({
  entry: { index: 'src/index.ts' },
  define: { __NFF_BRAIN_VERSION__: JSON.stringify(buildVersion) },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  // Inline the workspace core so the published tarball is self-contained.
  noExternal: ['@nff-brain/core'],
  // ...but NEVER inline the optional embedding runtime. It is installed on
  // demand into ~/.nff-brain/runtime and resolved at runtime by
  // semanticRuntime.ts; bundling it would defeat the zero-dep tarball. embed.ts
  // already hides the import behind new Function — this is belt-and-braces, and
  // e2e.test.ts asserts the built artifact stays clean.
  external: ['@huggingface/transformers'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Resolve @nff-brain/core through its `nff-brain-source` export condition, so
  // the bundle keeps inlining core's TypeScript sources exactly as it did before
  // core became publishable. Without this, tsup would pick up core's `default`
  // condition (dist/) and a stale or missing build would silently ship.
  esbuildOptions(options) {
    options.conditions = ['nff-brain-source', ...(options.conditions ?? [])];
  },
});
