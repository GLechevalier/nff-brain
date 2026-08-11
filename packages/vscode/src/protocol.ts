// Typed postMessage protocol between the extension host (sole filesystem
// authority) and the webview (dumb renderer). Shared by both sides via import.

export type NodeSource = 'project' | 'global';

// Category/origin literals are duplicated from core on purpose — this file must
// stay value-free and dependency-free (it is bundled into the browser webview).
// Keep in sync with CATEGORIES / BrainNode['origin'] in core/src/types.ts.
export interface ViewNode {
  id: string;
  title: string;
  category: 'core' | 'analysis' | 'rules' | 'strategy' | 'decision' | 'preference' | 'task';
  content: string;
  x: number;
  y: number;
  size: number;
  origin: 'seed' | 'agent' | 'graphify' | 'import';
  lastUpdated: string;
  recallCount: number;
  lastRecalledAt?: string; // ISO — seeds the glow when a panel opens late
  confidence?: number; // 0..1, present on imported nodes
  source: NodeSource;
  relatedIds: string[];
}

// One "the agent looked at these nodes" moment, relayed from
// .nff-brain/activity.jsonl. Kind literals are duplicated from core on
// purpose — this file must stay value-free and dependency-free (it is
// bundled into the browser webview).
export interface ViewActivityEvent {
  at: string; // ISO
  kind: 'recall' | 'prompt' | 'search' | 'expand' | 'distill';
  ids: string[]; // wave order
  seedCount?: number;
}

export interface ViewEdge {
  from: string;
  to: string;
  strength: number;
}

// extension → webview
export type ExtToWeb =
  | { type: 'graph'; nodes: ViewNode[]; edges: ViewEdge[]; projectName: string }
  | { type: 'notice'; text: string }
  | { type: 'busy'; on: boolean }
  // replay: true = history sent on panel open — glow at decayed intensity, no
  // arrival flash. Otherwise a live event that just happened.
  | { type: 'activity'; events: ViewActivityEvent[]; replay?: boolean };

// webview → extension. Node reading/editing happens in a NATIVE editor tab
// (the nffbrain: virtual filesystem) — the webview only asks to open things.
export type WebToExt =
  | { type: 'ready' }
  | { type: 'openNode'; id: string }
  | { type: 'createNodeRequest' }
  | { type: 'merge' };
