// BYOK path for turning a finished recording into a replayable workflow.
// Read the pending trace, run the distiller prompt through the user's own
// provider key (the cheap 'background' slot), validate the reply into a
// WorkflowSpec, and commit it to the LOCAL WORKFLOW STORE as source:'local'.
// (The pre-d8e040a version of this file wrote a brain node instead; the local
// brain returns in a later slice — the workflow store is what replay reads.)
// Paired mode distills server-side (POST /v1/trace) instead.
//
// Fail-open like the clip drain: any error leaves nb.tracePending in place so
// a later attempt can retry, and never throws into the caller.

import { buildWorkflowPrompt, parseWorkflowResponse } from '@nff-brain/core/workflowDistill';
import { makeProviderOneShot } from './providerClient.js';
import { upsertWorkflow } from './workflowStore.js';
import { getTracePending, setTracePending } from './storage.js';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

export interface DistillResult {
  ok: boolean;
  workflowId?: string;
  error?: string;
}

/**
 * Distill the one pending trace into a stored workflow. No-op (ok:false) when
 * there's nothing pending or no provider key. Leaves the trace queued on any
 * failure so it can be retried.
 */
export async function distillPendingTrace(): Promise<DistillResult> {
  const trace = await getTracePending();
  if (!trace) return { ok: false, error: 'no recording to distill' };

  const oneShot = await makeProviderOneShot('background');
  if (!oneShot) return { ok: false, error: 'add an API key in Settings to turn recordings into workflows' };

  const { prompt } = buildWorkflowPrompt(trace);
  let raw: string;
  try {
    raw = await oneShot(prompt);
  } catch {
    return { ok: false, error: 'the provider did not answer — the recording is kept, try again later' };
  }

  const spec = parseWorkflowResponse(raw, {
    sourceTraceId: trace.id,
    recordedAt: trace.endedAt,
    site: hostOf(trace.startUrl),
  });
  if (!spec) return { ok: false, error: 'could not turn this recording into a workflow — the recording is kept' };

  // Deterministic id from the trace: re-running a stuck distillation updates
  // the same entry instead of piling up near-duplicates.
  const id = `wf_${trace.id}`;
  const saved = await upsertWorkflow({
    id,
    title: trace.title || spec.intent,
    intent: spec.intent,
    site: spec.site,
    params: spec.params.map((p) => p.name),
    spec,
    savedAt: new Date().toISOString(),
    source: 'local',
  });
  if (!saved.ok) return { ok: false, error: saved.error };

  await setTracePending(null);
  return { ok: true, workflowId: id };
}
