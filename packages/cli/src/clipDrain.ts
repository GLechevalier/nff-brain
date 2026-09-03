// The clip drain: turn queued browser captures into brain nodes. Runs from the
// SessionEnd hook (before the transcript distill, and before its early returns
// — a browsing-only session has a short transcript and a full queue) and from
// `nff-brain clips --drain`.
//
// Budget: ONE LLM call per drain (45s) + the transcript distill (60s) fits the
// 120s hook window with slack. The batch is capped; anything past the cap stays
// queued — takeClips' at-least-once semantics make that free — and the
// clip-map ledger is the id-keyed dedupe that absorbs redelivery.

import {
  appendActivity,
  appendClipMap,
  applyClips,
  buildClipPrompt,
  compactClipMap,
  finishTake,
  isClipTierNode,
  loadBrain,
  MAX_CLIP_NODES,
  MAX_PAGEVISIT_NODES,
  mutateBrain,
  parseClipResponse,
  pruneClips,
  runClaude,
  seenClipIds,
  takeClips,
  type AppendClipMapInput,
  type BrainPaths,
  type ClipRecord,
} from '@nff-brain/core';
import { logToBrainDir } from './util.js';

export const MAX_CLIPS_PER_DRAIN = 25;
export const CLIP_DRAIN_TIMEOUT_MS = 45_000;

export interface DrainClipsOptions {
  model?: string;
  timeoutMs?: number;
}

export interface DrainClipsResult {
  /** Node ids created (new) and refined (re-captured) across both brains. */
  created: string[];
  refined: string[];
  /** Clips consumed this run (ledgered), including ones judged worthless. */
  processed: number;
  /** Clips left for the next drain (over the batch cap, or a failed parse). */
  leftQueued: number;
}

const EMPTY: DrainClipsResult = { created: [], refined: [], processed: 0, leftQueued: 0 };

interface QueueTake {
  brainPath: string;
  records: ClipRecord[];
  handle: string | null;
}

/**
 * Drain both queues (global + project) with one LLM call. Fail-open: any error
 * logs to last-distill.log and returns — an unfinished take is simply folded
 * back in by the next drain.
 */
export async function drainClips(paths: BrainPaths, opts: DrainClipsOptions = {}): Promise<DrainClipsResult> {
  try {
    return await drainClipsInner(paths, opts);
  } catch (err) {
    logToBrainDir(paths.project, 'last-distill.log', `clip drain failed open: ${String(err)}`);
    return EMPTY;
  }
}

async function drainClipsInner(paths: BrainPaths, opts: DrainClipsOptions): Promise<DrainClipsResult> {
  const targets: Array<{ target: 'global' | 'project'; brainPath: string }> = [
    { target: 'global', brainPath: paths.global },
  ];
  // A workspace rooted at the home directory makes both paths the same file.
  if (paths.project !== paths.global) targets.push({ target: 'project', brainPath: paths.project });

  const takes = new Map<'global' | 'project', QueueTake>();
  for (const t of targets) {
    const take = takeClips(t.brainPath);
    takes.set(t.target, { brainPath: t.brainPath, ...take });
  }
  const allRecords = [...takes.values()].flatMap((t) => t.records);
  if (allRecords.length === 0) {
    for (const t of takes.values()) if (t.handle) finishTake(t.handle);
    return EMPTY;
  }

  // The ledger union across both brains: a redelivered clip is dropped no
  // matter which brain its node landed in.
  const seen = new Set<string>();
  for (const t of targets) for (const id of seenClipIds(t.brainPath)) seen.add(id);
  const fresh = allRecords.filter((r) => !seen.has(r.id));

  if (fresh.length === 0) {
    // Everything redelivered was already ledgered — the queue can go.
    for (const t of takes.values()) if (t.handle) finishTake(t.handle);
    return EMPTY;
  }

  // Explicit clips always win the batch cap — a flood of passive page visits
  // must not push a "Remember this" capture to next session. A stable sort on
  // "is this a page visit" preserves chronological order within each tier.
  const prioritized = [...fresh].sort((a, b) => Number(a.kind === 'pagevisit') - Number(b.kind === 'pagevisit'));
  const batch = prioritized.slice(0, MAX_CLIPS_PER_DRAIN);
  const batchIds = new Set(batch.map((r) => r.id));
  const clipsById = new Map(batch.map((r) => [r.id, r]));

  // Known clip-tier nodes from BOTH brains — the model flags re-captures
  // against them (clip AND pagevisit, so a re-visited page isn't re-minted).
  const knownClipNodes = targets
    .flatMap((t) => loadBrain(t.brainPath)?.nodes ?? [])
    .filter(isClipTierNode)
    .map((n) => ({ id: n.id, title: n.title, sourceUrl: n.sourceUrl }));

  const prompt = buildClipPrompt({ clips: batch, knownClipNodes });
  const raw = await runClaude(prompt, {
    model: opts.model,
    timeoutMs: opts.timeoutMs ?? CLIP_DRAIN_TIMEOUT_MS,
  });
  const parsed = parseClipResponse(raw, batch);
  if (!parsed) {
    // No parseable JSON: do NOT ledger, do NOT finishTake — the whole batch
    // redelivers next session and costs nothing now.
    logToBrainDir(paths.project, 'last-distill.log', 'clip drain: clipper returned no parseable JSON; batch left queued');
    return { ...EMPTY, leftQueued: fresh.length };
  }

  const result: DrainClipsResult = {
    created: [],
    refined: [],
    processed: batch.length,
    leftQueued: fresh.length - batch.length,
  };

  const targetOf = (clipId: string): 'global' | 'project' => {
    const t = clipsById.get(clipId)?.target;
    return t === 'project' && takes.has('project') ? 'project' : 'global';
  };

  for (const t of targets) {
    // A proposal belongs to the brain its FIRST clip targeted; duplicates route
    // by their own clip's target (applyClips re-validates the `of` node there).
    const proposals = parsed.proposals.filter((p) => targetOf(p.clipIds[0]) === t.target);
    const duplicates = parsed.duplicates.filter((d) => targetOf(d.clipId) === t.target);
    const batchForTarget = batch.filter((r) => targetOf(r.id) === t.target);
    if (batchForTarget.length === 0 && proposals.length === 0) continue;

    const applied = mutateBrain(t.brainPath, (brain) => {
      const r = applyClips(brain, proposals, duplicates, clipsById);
      // Each origin has its own budget — a heavy browsing day can never crowd
      // out nodes the user explicitly asked to remember.
      const evicted = [
        ...pruneClips(brain, MAX_CLIP_NODES, 'clip'),
        ...pruneClips(brain, MAX_PAGEVISIT_NODES, 'pagevisit'),
      ];
      return { r, evicted };
    });

    // Ledger EVERY batch clip of this target — `nodeIds: []` means "processed,
    // judged worthless" and is exactly what dedupes redelivery.
    const entries: AppendClipMapInput[] = batchForTarget.map((r) => ({
      clipId: r.id,
      clientId: r.clientId,
      nodeIds: applied.r.byClip.get(r.id) ?? [],
    }));
    // Proposals can fold a clip from this target with one from the other; make
    // sure every mapped clip of this target is ledgered even if routed above.
    appendClipMap(t.brainPath, entries);
    if (applied.evicted.length > 0) {
      compactClipMap(t.brainPath, { dropNodeIds: new Set(applied.evicted) });
    }

    result.created.push(...applied.r.created);
    result.refined.push(...applied.r.refined);
  }

  // Release each queue only when every one of its records was consumed this run
  // (in the batch or already ledgered). An overflow leaves the processing file;
  // the next drain folds it back in and the ledger skips the done ones.
  for (const t of takes.values()) {
    if (!t.handle) continue;
    const allCovered = t.records.every((r) => batchIds.has(r.id) || seen.has(r.id));
    if (allCovered) finishTake(t.handle);
  }

  if (result.created.length > 0) {
    // The glow belongs to whichever workspace's graph panel is watching.
    appendActivity(paths.project, { kind: 'distill', ids: result.created });
  }

  logToBrainDir(
    paths.project,
    'last-distill.log',
    `clip drain: ${result.processed} clip(s) → ${result.created.length} new node(s)` +
      `${result.refined.length ? `, ${result.refined.length} refined` : ''}` +
      `${result.leftQueued ? `, ${result.leftQueued} left queued` : ''}`,
  );
  return result;
}
