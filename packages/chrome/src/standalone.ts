// Standalone-mode message surfaces: the local-brain siblings of the paired
// getNodes/getGraph/searchBrain/chatAsk/clearActivity routes. sw.ts calls
// handleStandaloneMessage() BEFORE its switch whenever no pairing is stored;
// a null return means "no standalone meaning" and the message falls through to
// the existing paired guards, which keeps all paired cases byte-identical.
//
// Response shapes deliberately mirror the serve routes (routes.ts) so the
// DevTools panel renders both modes with zero changes.

import { removeNode } from '@nff-brain/core/brainGraph';
import { buildChatPrompt, cleanChatAnswer } from '@nff-brain/core/chatPrompt';
import { ProviderError } from '@nff-brain/core/provider';
import { fuseRanked } from '@nff-brain/core/rank';
import type { BrainFile } from '@nff-brain/core/types';
import { clearActivity, removableNodeCount } from './activity.js';
import { mutateLocalBrain, readLocalBrain } from './brainStore.js';
import { makeProviderOneShot } from './providerClient.js';
import { getActivity } from './storage.js';
import type { NodesResponse, PopupToSw, SearchResponse, SwToPopup } from './protocol.js';

const NODES_LIMIT_DEFAULT = 20;
const NODES_LIMIT_MAX = 100;
const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_Q_MAX = 256;
const EXCERPT_MAX = 240;
const MAX_RELATED = 3;
const CHAT_RETRIEVAL_LIMIT = 8;

function clampLimit(raw: number | undefined, dflt: number, max: number): number {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) return dflt;
  return Math.min(Math.floor(raw!), max);
}

function excerpt(content: string | undefined): string {
  const t = (content ?? '').replace(/\s+/g, ' ').trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1)}…` : t;
}

function localNodes(brain: BrainFile, limit: number): NodesResponse {
  const recent = [...brain.nodes]
    .sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : a.lastUpdated > b.lastUpdated ? -1 : 0))
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      title: n.title,
      category: n.category,
      origin: n.origin,
      source: 'global' as const,
      lastUpdated: n.lastUpdated,
      excerpt: excerpt(n.content),
    }));
  return {
    ok: true,
    updatedAt: brain.nodes.length ? brain.updatedAt : null,
    merged: { nodes: brain.nodes.length, edges: brain.edges.length },
    workspace: { name: 'standalone', nodes: 0, edges: 0 },
    global: { nodes: brain.nodes.length, edges: brain.edges.length },
    recent,
  };
}

function localSearch(brain: BrainFile, qRaw: string, limit: number): SearchResponse {
  const q = qRaw.trim().slice(0, SEARCH_Q_MAX);
  if (!q) return { ok: true, q: '', count: 0, hits: [] };
  const titleById = new Map(brain.nodes.map((n) => [n.id, n.title]));
  const hits = fuseRanked(q, brain.nodes, null, { limit }).map((r) => {
    const related = brain.edges
      .filter((e) => e.from === r.node.id || e.to === r.node.id)
      .map((e) => ({ id: e.from === r.node.id ? e.to : e.from, strength: e.strength }))
      .filter((e) => titleById.has(e.id))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_RELATED)
      .map((e) => ({ id: e.id, title: titleById.get(e.id)!, strength: e.strength }));
    return {
      id: r.node.id,
      title: r.node.title,
      category: r.node.category,
      origin: r.node.origin,
      source: 'global' as const,
      lastUpdated: r.node.lastUpdated,
      score: r.fused,
      excerpt: excerpt(r.node.content),
      related,
    };
  });
  return { ok: true, q, count: hits.length, hits };
}

async function localChat(message: string, history: Array<{ role: 'user' | 'assistant'; text: string }>): Promise<SwToPopup> {
  const oneShot = await makeProviderOneShot('chat');
  if (!oneShot) {
    return { type: 'error', message: 'add an API key in Settings to chat with your brain (or pair with a local server)' };
  }
  const brain = await readLocalBrain();
  const ranked = fuseRanked(message, brain.nodes, null, { limit: CHAT_RETRIEVAL_LIMIT });
  const nodes = ranked.map((r) => ({ id: r.node.id, title: r.node.title, content: r.node.content ?? '' }));
  try {
    const raw = await oneShot(buildChatPrompt({ message, history, nodes }));
    return {
      type: 'chatAnswer',
      answer: cleanChatAnswer(raw),
      sources: nodes.map((n) => ({ id: n.id, title: n.title })),
    };
  } catch (err) {
    // ProviderError messages are short and user-showable by construction.
    return { type: 'error', message: err instanceof ProviderError ? err.message : 'the brain did not answer in time' };
  }
}

/**
 * Delete requested LOCAL clip nodes, then clear the buffer — mirroring the
 * paired path's discipline: any failure returns an error WITHOUT clearing, so
 * the clip→node mapping is never orphaned.
 */
async function localClearActivity(alsoRemoveNodes: boolean): Promise<SwToPopup | 'handled'> {
  if (alsoRemoveNodes) {
    const activity = await getActivity();
    if (removableNodeCount(activity) > 0) {
      const nodeIds = [...new Set(activity.flatMap((r) => r.nodeIds))];
      try {
        await mutateLocalBrain((brain) => {
          for (const id of nodeIds) {
            const node = brain.nodes.find((n) => n.id === id);
            // Standalone mints only clip nodes, but enforce the gate anyway —
            // same hard line as /v1/retract.
            if (node && node.origin === 'clip') removeNode(brain, id);
          }
        });
      } catch {
        return { type: 'error', message: 'could not update the local brain — nothing was deleted' };
      }
    }
  }
  await clearActivity();
  return 'handled'; // work done — sw.ts replies with the default state snapshot
}

/**
 * Returns a reply for messages that have a standalone meaning; 'handled' when
 * the work is done and the default state reply should follow; null when the
 * message has no standalone meaning (falls through to the paired guards).
 * Only ever called when NO pairing is stored.
 */
export async function handleStandaloneMessage(msg: PopupToSw): Promise<SwToPopup | 'handled' | null> {
  switch (msg.type) {
    case 'getNodes':
      return { type: 'nodes', data: localNodes(await readLocalBrain(), clampLimit(msg.limit, NODES_LIMIT_DEFAULT, NODES_LIMIT_MAX)) };

    case 'searchBrain':
      return { type: 'search', data: localSearch(await readLocalBrain(), msg.q, clampLimit(msg.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX)) };

    case 'getGraph': {
      const brain = await readLocalBrain();
      return {
        type: 'graph',
        nodes: brain.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          category: n.category,
          origin: n.origin,
          x: n.x,
          y: n.y,
          size: n.size,
          color: n.color,
        })),
        edges: brain.edges.map((e) => ({ from: e.from, to: e.to, strength: e.strength })),
      };
    }

    case 'chatAsk':
      return localChat(msg.message, msg.history);

    case 'clearActivity':
      return localClearActivity(msg.alsoRemoveNodes);

    default:
      return null;
  }
}
