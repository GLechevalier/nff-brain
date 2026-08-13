// The workflow distiller's pure half: turn a compacted event trace into a
// generalized WorkflowSpec. Modeled on clipDistill.ts — the events are
// index-addressed (#0, #1, …) and the model returns strict JSON that a tolerant
// parser validates; a bad step costs that step, a null parse means "retry the
// batch" (never a thrown error). The verb vocabulary the model may cite is the
// shared browserVerbs union, so a workflow hint always names a real verb.
//
// The whole point is GENERALIZATION: the prompt forces every literal into a
// param and every repeated block (tagged by traceCompact) into one loop step.

import { extractJson } from './jsonExtract.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import { VERB_KINDS } from './browserVerbs.js';
import { validateWorkflowSpec, type WorkflowSpec } from './workflow.js';
import { compactTrace } from './traceCompact.js';
import type { TraceEvent, TraceRecord } from './trace.js';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function eventLine(e: TraceEvent, i: number): string {
  const t = e.target;
  const who = t ? `${t.role ?? t.tag}${t.name ? ` "${t.name}"` : ''}${t.landmark ? ` [in ${t.landmark}]` : ''}` : '';
  const val = e.redacted ? ' =«redacted»' : e.value ? ` ="${e.value}"` : '';
  const key = e.key ? ` key=${e.key}` : '';
  const dir = e.dir ? ` ${e.dir}` : '';
  const rep = e.repeatGroup ? `  «repeat group ${e.repeatGroup}»` : '';
  const url = ` @${hostOf(e.url)}`;
  return `#${i} [${e.kind}]${who ? ' ' + who : ''}${val}${key}${dir}${url}${rep}`;
}

/**
 * Build the distiller prompt from a raw trace. Compacts first (dedupe + repeat
 * detection) so the repeat annotations reach the model. Returns the prompt plus
 * the compacted events (the caller keeps them only for logging).
 */
export function buildWorkflowPrompt(trace: TraceRecord): { prompt: string; repeatGroups: number } {
  const { events, repeatGroups } = compactTrace(trace.events);
  const site = hostOf(trace.startUrl);
  const lines = events.map(eventLine).join('\n');

  const prompt = `${NFF_PROMPT_MARKERS.workflowDistiller}. You turn ONE recorded browser session into a REUSABLE, generalized workflow that an automation agent can replay for the same KIND of task with different inputs.

The recording happened on ${site}. Here is the event trace, index-addressed:

${lines}

Return STRICT JSON only, no prose, exactly this shape:
{
  "intent": "one sentence, site-agnostic, describing WHAT is accomplished (<=200 chars)",
  "params": [ { "name": "camelCase", "description": "<=120", "example": "the value seen in the recording", "required": true } ],
  "steps": [
    { "intent": "site-agnostic, references {paramName}, <=160",
      "verbs": ["one or more of the allowed verbs below"],
      "params": ["paramName", ...],
      "loop": { "over": "what is iterated, e.g. search results", "countParam": "targetCount", "body": [ { "intent": "...", "verbs": [...] } ] },
      "success": "observable signal this step is done (<=120)" }
  ],
  "successCriteria": "how the whole task is known to be complete (<=200)"
}

RULES:
- Every literal the user typed or picked (search text, a location, a count, a filter choice) MUST become a param. Steps reference {paramName}; never bake the literal into the step text.
- Any events marked «repeat group N» are ONE loop step with a countParam — NEVER repeat them as separate steps. Put the repeated actions in loop.body.
- "intent" describes the goal of a step in words that work on a different page, not "click the button at #3". The recording's specifics are recovered from the event indices at replay time.
- "verbs" may ONLY be drawn from: ${VERB_KINDS.join(', ')}.
- Omit obvious noise (a stray scroll, a mis-click the user immediately undid).
- "loop" is optional and only for genuinely repeated sequences. Most steps have no loop.`;

  return { prompt, repeatGroups };
}

/**
 * Parse the distiller's reply into a validated WorkflowSpec. Tolerant like
 * parseClipResponse: returns null only when nothing usable parsed (so the job
 * retries), and clamps/drops individual bad fields otherwise. `ctx` carries the
 * trusted provenance the model never sees.
 */
export function parseWorkflowResponse(
  raw: string,
  ctx: { sourceTraceId: string; recordedAt: string; site: string },
): WorkflowSpec | null {
  const json = extractJson<Record<string, unknown>>(raw);
  if (!json) return null;
  return validateWorkflowSpec(json, ctx);
}
