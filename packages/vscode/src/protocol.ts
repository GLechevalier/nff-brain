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
  /** True once a layout pass settled x/y. Absent ⇒ this node still needs placing. */
  laidOut?: boolean;
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

// Semantic search rides the same channel. The MODEL never runs in the webview:
// it is node-only (native onnxruntime) and the webview CSP forbids wasm-eval
// anyway. The host owns the model and the vector sidecar; the webview receives
// precomputed unit vectors once, does pure cosine locally (vector.ts is
// browser-safe), and asks the host to embed each QUERY. Lexical results render
// instantly meanwhile, so semantic can only ever improve the ordering.
export interface ViewVectorEntry {
  id: string;
  /** base64 little-endian float32, unit-normalised — see core/src/vector.ts. */
  v: string;
}

// extension → webview
export type ExtToWeb =
  | { type: 'graph'; nodes: ViewNode[]; edges: ViewEdge[]; projectName: string }
  | { type: 'notice'; text: string }
  | { type: 'busy'; on: boolean }
  // Pushed on `ready` and whenever vectors.json changes — never on the 150 ms
  // broadcastGraph debounce. `enabled: false` means "semantic is off", which is
  // a normal state, not an error.
  | { type: 'vectors'; enabled: boolean; dim: number; entries: ViewVectorEntry[] }
  // Reply to embedQuery. `seq` lets the webview drop answers to stale keystrokes.
  | { type: 'queryVector'; seq: number; v: string | null }
  // replay: true = history sent on panel open — glow at decayed intensity, no
  // arrival flash. Otherwise a live event that just happened.
  | { type: 'activity'; events: ViewActivityEvent[]; replay?: boolean };

// webview → extension. Node reading/editing happens in a NATIVE editor tab
// (the nffbrain: virtual filesystem) — the webview only asks to open things.
export type WebToExt =
  | { type: 'ready' }
  | { type: 'openNode'; id: string }
  | { type: 'createNodeRequest' }
  | { type: 'merge' }
  // Debounced, one per settled keystroke. The host answers with queryVector.
  | { type: 'embedQuery'; query: string; seq: number }
  // Positions the webview's incremental layout settled for nodes that had none.
  // Sent at most once per set of new nodes — see the loop guard in App.tsx.
  | { type: 'layout'; positions: Array<{ id: string; x: number; y: number }> };
