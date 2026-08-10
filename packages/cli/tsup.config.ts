import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  // Inline the workspace core so the published tarball is self-contained.
  noExternal: ['@nff-brain/core'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
