// Standalone (BYOK) path for turning a finished recording into a workflow node.
// Mirrors standaloneDrain.ts: read the pending trace, run the distiller prompt
// through the user's own provider key (background slot), validate the reply into
// a WorkflowSpec, and commit it to the local brain as one origin:'workflow'
// node. Paired mode distills server-side (POST /v1/trace) instead — a later
// milestone; here, with a key, it happens entirely in the browser.
//
// Fail-open like the clip drain: any error leaves nb.tracePending in place so a
// later attempt can retry, and never throws into the caller.

import { buildWorkflowPrompt, parseWorkflowResponse } from '@nff-brain/core/workflowDistill';
import { applyWorkflow } from '@nff-brain/core/workflowApply';
import { mutateLocalBrain } from './brainStore.js';
import { makeProviderOneShot } from './providerClient.js';
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
  nodeId?: string;
  error?: string;
}

/**
 * Distill the one pending trace into a workflow node. No-op (ok:false) when
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

  const result = await mutateLocalBrain((brain) => applyWorkflow(brain, spec, trace.title || spec.intent));
  await setTracePending(null);
  return { ok: true, nodeId: result.id };
}
