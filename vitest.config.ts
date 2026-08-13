import { defineConfig } from 'vitest/config';

// The suite ran on pure defaults until @nff-brain/core became a publishable
// package. Now core's exports map gates its TypeScript sources behind the
// `nff-brain-source` condition and points every other resolver at `dist/`, so
// without this config the ~20 test files that import `@nff-brain/core/*` by
// package specifier would resolve into a dist that `vitest run` never builds.
//
// Both keys are set on purpose: `resolve.conditions` covers the client/web
// path, `ssr.resolve.conditions` the node path that Vitest's default `node`
// environment actually takes. Setting only one leaves the other on defaults.
const CORE_SOURCE = ['nff-brain-source'];

export default defineConfig({
  resolve: { conditions: CORE_SOURCE },
  ssr: { resolve: { conditions: CORE_SOURCE } },
});
