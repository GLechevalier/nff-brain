import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
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
