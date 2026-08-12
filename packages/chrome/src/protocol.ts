// Two protocols in one file, both value-free apart from the type guards, in the
// same discipline as packages/vscode/src/protocol.ts:
//   1. popup ⇄ service worker (chrome.runtime messages)
//   2. extension → nff-brain serve (the /v1 HTTP surface)

import type { AllowRule, Capture, ConnectionPhase, Health } from './schema.js';

/**
 * Owned by item 0 (packages/core/src/serveConfig.ts). This is the ONLY place
 * the number is written on the extension side — the popup exposes it as an
 * editable field so a port collision is a one-field fix, not a re-release.
 */
export const DEFAULT_PORT = 7373;
export const PORT_PROBE_COUNT = 5;

/** Always the literal loopback IP: `localhost` is dual-stack and can resolve to
 *  ::1, which the server deliberately does not bind. */
export const HOST = '127.0.0.1';

export const REQUEST_TIMEOUT_MS = 2500;

// ── the wire (extension → server) ────────────────────────────────────────────

export interface HelloResponse {
  ok: true;
  name: 'nff-brain';
  protocol: number;
  version: string;
  serverId: string;
  paired: boolean;
  pairing: boolean;
  proof?: string;
}

export interface PairResponse {
  ok: true;
  token: string;
  clientId: string;
  serverId: string;
  origin: string;
}

export interface BrainSide {
  brainPath: string;
  exists: boolean;
  nodes: number;
  edges: number;
  updatedAt?: string;
  error?: string;
}

export interface StatusResponse {
  ok: true;
  protocol: number;
  version: string;
  serverId: string;
  workspace: BrainSide & { root: string; name: string };
  global: BrainSide;
  merged: { nodes: number; edges: number };
  capture: { defaultTarget: 'global' | 'project' };
  queue: { path: string; pending: number; bytes: number; full: boolean; maxBytes: number };
}

export interface ClipResponse {
  ok: true;
  id: string;
  target: 'global' | 'project';
  pending: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isBrainSide(v: unknown): boolean {
  return isObj(v) && typeof v.nodes === 'number' && typeof v.edges === 'number';
}

export function isHelloResponse(v: unknown): v is HelloResponse {
  return isObj(v) && v.ok === true && v.name === 'nff-brain' && typeof v.protocol === 'number';
}

export function isPairResponse(v: unknown): v is PairResponse {
  return isObj(v) && v.ok === true && typeof v.token === 'string' && typeof v.clientId === 'string';
}

/**
 * NEVER TRUST THE WIRE. A malformed body is a DISCONNECT, not a connection
 * reporting zero nodes — "0 nodes" is a real and alarming state, and it must
 * not be manufacturable by a broken or truncated response.
 */
export function isStatusResponse(v: unknown): v is StatusResponse {
  return (
    isObj(v) &&
    v.ok === true &&
    typeof v.version === 'string' &&
    isBrainSide(v.workspace) &&
    isBrainSide(v.global) &&
    isObj(v.merged) &&
    typeof v.merged.nodes === 'number'
  );
}

// ── popup ⇄ service worker ───────────────────────────────────────────────────

export type PopupToSw =
  | { type: 'getState' }
  | { type: 'probeNow' }
  | { type: 'pair'; port: number; code: string }
  | { type: 'unpair' }
  | { type: 'setCaptureEnabled'; enabled: boolean }
  | { type: 'addRule'; input: string }
  | { type: 'removeRule'; host: string }
  | { type: 'clearActivity'; alsoRemoveNodes: boolean };

/**
 * Everything the popup renders. Deliberately NOT StoredState: the bearer token
 * never crosses this channel. The popup has no use for it, and keeping it out
 * means a future popup bug cannot leak it into the DOM.
 */
export interface PublicState {
  phase: ConnectionPhase;
  port: number | null;
  health: Omit<Health, 'nextProbeAtMs'>;
  capture: Capture;
  rules: AllowRule[];
  activityCount: number;
  /** Σ nodeIds.length — drives whether the clear-history checkbox renders. */
  removableNodeCount: number;
}

export type SwToPopup = { type: 'state'; state: PublicState } | { type: 'error'; message: string };
