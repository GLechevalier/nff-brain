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
  origin: 'seed' | 'agent';
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

// webview → extension
export type WebToExt =
  | { type: 'ready' }
  | { type: 'createNode'; title: string; category: ViewNode['category']; content: string }
  | { type: 'editNode'; id: string; title: string; category: ViewNode['category']; content: string }
  | { type: 'deleteNode'; id: string }
  | { type: 'addEdgeRequest'; from: string }
  | { type: 'removeEdge'; from: string; to: string }
  | { type: 'reinforce'; from: string; to: string; delta: number }
  | { type: 'merge' };
