// POST /v1/import — the standalone→paired brain migration. The Chrome
// extension's standalone mode builds a local clip-origin brain; on first
// pairing it pushes that brain here, into the GLOBAL brain, then switches to
// thin-client mode.
//
// Invariants, each load-bearing:
//   - origin is FORCED to 'clip' on every imported node. /v1/retract deletes by
//     origin, so anything the extension can plant must remain something the
//     extension is allowed to delete — never a way to smuggle agent/seed nodes.
//   - category can never be 'core' (a browser clip must not win the spine's
//     root lottery) — same rule as clipDistill's named-array prompt.
//   - imported ids keep their identity unless they collide with a NON-clip
//     node; then they are re-minted DETERMINISTICALLY (-2, -3, …) and reported
//     in `remapped`, so re-running the same import upserts over itself —
//     idempotent by construction, which is what makes partial-failure retry safe.
//   - every imported node lands in the clip-map ledger attributed to the
//     requesting client, so post-migration retraction works through the
//     existing three-gate /v1/retract path unchanged.
//
// Synchronous on the request path (one mutateBrain over a few hundred nodes is
// milliseconds) — serve has no background timers and this route adds none.

import {
  MAX_CLIP_NODES,
  appendClipMap,
  asCategory,
  clampStrength,
  compactClipMap,
  mutateBrain,
  placeNode,
  pruneClips,
  slug,
  upsertEdge,
  upsertNode,
} from '@nff-brain/core';
import type { BrainFile, BrainNode, Category } from '@nff-brain/core';
import { readJsonBody, sendError, sendJson } from './http.js';
import type { Handler, Route } from './routes.js';

/** A 200-node clip brain serializes to ~300 KB; 1 MiB leaves headroom without
 *  inviting abuse. Enforced by readJsonBody (socket destroyed past the cap). */
export const IMPORT_BODY_MAX = 1024 * 1024;

/** Parse-work bounds — the prune bounds the RESULT, these bound the LOOP. */
const IMPORT_MAX_NODES = 400;
const IMPORT_MAX_EDGES = 1200;
const IMPORT_MAX_MAP = 600;

const TITLE_MAX = 80;
const CONTENT_MAX = 1200;

interface RawImportNode {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  content?: unknown;
  sourceUrl?: unknown;
  x?: unknown;
  y?: unknown;
  size?: unknown;
  color?: unknown;
  recallCount?: unknown;
  lastUpdated?: unknown;
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return undefined;
  return v.slice(0, 512);
}

function clipCategory(v: unknown): Category {
  const c = asCategory(v);
  return c === 'core' ? 'strategy' : c;
}

/**
 * Deterministic collision handling: keep the id when it is free or already a
 * clip node (idempotent overwrite); when it names a NON-clip node, walk -2, -3…
 * to the first suffix that is free or a clip node. The same input always maps
 * to the same output id, so retries never fork.
 */
function resolveImportId(brain: BrainFile, wanted: string): string {
  const usable = (id: string): boolean => {
    const existing = brain.nodes.find((n) => n.id === id);
    return !existing || existing.origin === 'clip';
  };
  if (usable(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted.slice(0, 60 - `-${n}`.length)}-${n}`;
    if (usable(candidate)) return candidate;
  }
}

const importHandler: Handler = async (req, res, ctx) => {
  const body = (await readJsonBody(req, IMPORT_BODY_MAX)) as {
    nodes?: unknown;
    edges?: unknown;
    map?: unknown;
  };
  const rawNodes = Array.isArray(body?.nodes) ? (body.nodes as RawImportNode[]).slice(0, IMPORT_MAX_NODES) : [];
  const rawEdges = Array.isArray(body?.edges)
    ? (body.edges as Array<{ from?: unknown; to?: unknown; strength?: unknown }>).slice(0, IMPORT_MAX_EDGES)
    : [];
  const rawMap = Array.isArray(body?.map)
    ? (body.map as Array<{ clipId?: unknown; nodeIds?: unknown }>).slice(0, IMPORT_MAX_MAP)
    : [];

  if (rawNodes.length === 0) {
    sendJson(res, 200, { ok: true, imported: 0, remapped: [], evicted: [] }, ctx.cors);
    return;
  }

  const clientId = ctx.client!.id;
  const brainPath = ctx.state.opts.globalBrainPath;
  const now = new Date().toISOString();

  const outcome = mutateBrain(brainPath, (brain) => {
    const remapped: Array<{ from: string; to: string }> = [];
    const idByRequested = new Map<string, string>();

    for (const rn of rawNodes) {
      if (!rn || typeof rn !== 'object') continue;
      const title = typeof rn.title === 'string' ? rn.title.trim().slice(0, TITLE_MAX) : '';
      const content = typeof rn.content === 'string' ? rn.content.trim().slice(0, CONTENT_MAX) : '';
      if (!title || !content) continue;
      const wanted = slug(typeof rn.id === 'string' && rn.id.trim() ? rn.id : title);
      if (!wanted || idByRequested.has(wanted)) continue;

      const id = resolveImportId(brain, wanted);
      if (id !== wanted) remapped.push({ from: wanted, to: id });
      idByRequested.set(wanted, id);

      const category = clipCategory(rn.category);
      const existing = brain.nodes.find((n) => n.id === id);
      const geometryOk =
        typeof rn.x === 'number' && typeof rn.y === 'number' && typeof rn.size === 'number' && typeof rn.color === 'string';
      const node: BrainNode = {
        id,
        title,
        category,
        content,
        ...(geometryOk
          ? { x: rn.x as number, y: rn.y as number, size: rn.size as number, color: rn.color as string }
          : (existing
              ? { x: existing.x, y: existing.y, size: existing.size, color: existing.color }
              : placeNode(category))),
        origin: 'clip', // FORCED — see header
        sourceUrl: httpUrl(rn.sourceUrl),
        lastUpdated: now,
        recallCount:
          typeof rn.recallCount === 'number' && rn.recallCount >= 0
            ? Math.floor(rn.recallCount)
            : (existing?.recallCount ?? 0),
        lastRecalledAt: existing?.lastRecalledAt,
      };
      upsertNode(brain, node);
    }

    // Edges only between imported nodes (post-remap) — an import must not be
    // able to rewire the agent graph.
    const importedIds = new Set(idByRequested.values());
    for (const re of rawEdges) {
      const from = typeof re.from === 'string' ? (idByRequested.get(slug(re.from)) ?? '') : '';
      const to = typeof re.to === 'string' ? (idByRequested.get(slug(re.to)) ?? '') : '';
      if (!from || !to || from === to || !importedIds.has(from) || !importedIds.has(to)) continue;
      const strength = typeof re.strength === 'number' ? clampStrength(re.strength) : 0.6;
      upsertEdge(brain, { from, to, strength });
    }

    const evicted = pruneClips(brain, MAX_CLIP_NODES);
    return { remapped, idByRequested, evicted, imported: importedIds.size };
  });

  // Ledger AFTER the brain write: attribute every surviving imported node to the
  // requesting client so /v1/retract's gates keep working post-migration. Map
  // entries the extension supplied keep their real clipIds; the rest get a
  // synthetic import marker.
  const evictedSet = new Set(outcome.evicted);
  const importedIdSet = new Set(outcome.idByRequested.values());
  const covered = new Set<string>();
  const entries: Array<{ clipId: string; clientId: string; nodeIds: string[] }> = [];
  for (const m of rawMap) {
    const clipId = typeof m.clipId === 'string' ? m.clipId.slice(0, 128) : '';
    const nodeIds = Array.isArray(m.nodeIds)
      ? m.nodeIds
          .filter((v): v is string => typeof v === 'string')
          .map((id) => outcome.idByRequested.get(id) ?? id)
          .filter((id) => importedIdSet.has(id) && !evictedSet.has(id))
      : [];
    if (!clipId || nodeIds.length === 0) continue;
    nodeIds.forEach((id) => covered.add(id));
    entries.push({ clipId, clientId, nodeIds });
  }
  for (const id of outcome.idByRequested.values()) {
    if (covered.has(id) || evictedSet.has(id)) continue;
    entries.push({ clipId: `imp_${id}`, clientId, nodeIds: [id] });
  }
  appendClipMap(brainPath, entries);
  if (outcome.evicted.length > 0) compactClipMap(brainPath, { dropNodeIds: evictedSet });

  sendJson(
    res,
    201,
    { ok: true, imported: outcome.imported, remapped: outcome.remapped, evicted: outcome.evicted },
    ctx.cors,
  );
};

export const IMPORT_ROUTES: Record<string, Route> = {
  '/v1/import': { method: 'POST', auth: 'client', origin: 'paired', handler: importHandler },
};
