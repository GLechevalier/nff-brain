// Paired path for turning a finished recording into a workflow node — the
// server-side twin of standaloneTraceDistill.ts. The distillation itself (the
// claude -p call + validateWorkflowSpec + applyWorkflow) runs in `nff-brain
// serve` (POST /v1/trace); this just posts the pending trace and clears it on
// success, same fail-open posture as the standalone path: any error leaves
// nb.tracePending in place so a later attempt (or the standalone fallback,
// never both) can retry.

import * as client from './client.js';
import { HttpError } from './client.js';
import type { Pairing } from './schema.js';
import { getTracePending, setTracePending } from './storage.js';

export interface DistillResult {
  ok: boolean;
  nodeId?: string;
  error?: string;
}

/**
 * Distill the one pending trace into a workflow node through the paired
 * server. No-op (ok:false) when there's nothing pending. Leaves the trace
 * queued on any failure so it can be retried.
 */
export async function distillPairedTrace(pairing: Pairing): Promise<DistillResult> {
  const trace = await getTracePending();
  if (!trace) return { ok: false, error: 'no recording to distill' };

  try {
    const res = await client.postTrace(pairing.port, pairing.token, trace);
    await setTracePending(null);
    return { ok: true, nodeId: res.nodeId };
  } catch (err) {
    const message =
      err instanceof HttpError ? err.message : 'the brain did not answer — the recording is kept, try again later';
    return { ok: false, error: message };
  }
}
