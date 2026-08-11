import {
  EMBED_DIM,
  embedBatch,
  embedModel,
  indexBrain,
  loadBrain,
  loadVectors,
  resolveTransformers,
  vectorPlan,
} from '@nff-brain/core';

// Keep the vector sidecar fresh after a command that WRITES nodes, so users
// never have to remember `nff-brain index`.
//
// Three rules make this safe to call from the SessionEnd hook:
//   1. It only runs when a sidecar ALREADY exists. Semantic search is opt-in;
//      a first distill must not silently load a model and write ~840 KB.
//   2. The runtime probe is a filesystem path check (no model load), so the
//      common "semantic is off" case costs microseconds.
//   3. It never throws and never changes an exit code.
//
// Budget note: the SessionEnd hook needs `timeout: 120` in settings.json, and
// distill has already spent up to 60 s on `claude -p`. We only embed the ≤3
// nodes a distill can add — a cold model load (~0.5–3 s) plus a few embeddings.
// NFF_BRAIN_AUTO_INDEX=0 opts out entirely.

export interface RefreshResult {
  ran: boolean;
  embedded: number;
  reason?: string;
}

export async function refreshVectors(brainPath: string): Promise<RefreshResult> {
  try {
    if (process.env.NFF_BRAIN_AUTO_INDEX === '0') return { ran: false, embedded: 0, reason: 'disabled' };
    if (process.env.NFF_BRAIN_SEMANTIC === 'off') return { ran: false, embedded: 0, reason: 'semantic off' };

    // Cheapest checks first: no sidecar ⇒ the user never opted in.
    const existing = loadVectors(brainPath);
    if (!existing) return { ran: false, embedded: 0, reason: 'no vector index' };
    if (!resolveTransformers().installed) return { ran: false, embedded: 0, reason: 'runtime absent' };

    const brain = loadBrain(brainPath);
    if (!brain) return { ran: false, embedded: 0, reason: 'no brain' };

    const model = embedModel();
    const plan = vectorPlan(brain, existing, model);
    if (plan.stale.length === 0 && plan.orphaned.length === 0) {
      return { ran: false, embedded: 0, reason: 'already current' };
    }

    const res = await indexBrain(brainPath, brain, embedBatch, { model, dim: EMBED_DIM });
    return { ran: true, embedded: res.embedded };
  } catch (err) {
    // Fail-open by construction: a stale sidecar only degrades search quality
    // until the next `nff-brain index`, and must never break a session.
    return { ran: false, embedded: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}
