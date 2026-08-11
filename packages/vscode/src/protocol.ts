// Typed postMessage protocol between the extension host (sole filesystem
// authority) and the webview (dumb renderer). Shared by both sides via import.

export type NodeSource = 'project' | 'global';

export interface ViewNode {
  id: string;
  title: string;
  category: 'core' | 'analysis' | 'rules' | 'strategy';
  content: string;
  x: number;
  y: number;
  size: number;
  origin: 'seed' | 'agent' | 'graphify';
  lastUpdated: string;
  recallCount: number;
  source: NodeSource;
  relatedIds: string[];
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
  | { type: 'busy'; on: boolean };

// webview → extension. Node reading/editing happens in a NATIVE editor tab
// (the nffbrain: virtual filesystem) — the webview only asks to open things.
export type WebToExt =
  | { type: 'ready' }
  | { type: 'openNode'; id: string }
  | { type: 'createNodeRequest' }
  | { type: 'merge' };
