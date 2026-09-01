// The spacing/layout primitives moved into core (packages/core/src/layout.ts)
// when the graph gained a real force-directed layout: the CLI's `nff-brain
// layout` command needs the same code, and core is the only place both the CLI
// and this browser bundle can import from.
//
// Kept as a shim so the webview's existing `hash` import site (BrainGraph's
// per-node drift direction) stays put.
export { hash, spaceOutNodes, layoutBrain, LABEL_PAD } from '@nff-brain/core/layout';
export type {
  Pt,
  LayoutNode,
  LayoutEdge,
  LayoutSpine,
  SpaceOutOptions,
  LayoutOptions,
} from '@nff-brain/core/layout';
export { buildSpine, resolveRoot, isSpineId } from '@nff-brain/core/spine';
export type { SpineNode, SpineResult } from '@nff-brain/core/spine';
export { buildDensityClusters, isDensityClusterId, blobSize, DEFAULT_DENSITY_SCREEN_RADIUS, MERGE_SCREEN_SLACK } from '@nff-brain/core/density';
export type { DensityCluster } from '@nff-brain/core/density';
