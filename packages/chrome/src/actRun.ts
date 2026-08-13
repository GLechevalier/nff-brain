// The action run's lifecycle: start → (grant) → drive the tool-use loop → stop.
// The loop is runChatWithTools (the generalized BYOK loop) with the action
// tools; onTurn is the between-turns checkpoint that honors Stop and the action
// budget. State lives in nb.actRun (actStore) so the panel — a separate realm —
// renders it live and Stop survives a re-render.
//
// No module-level mutable state. The loop runs as a floating promise kept alive
// by the panel's nb.act Port (heartbeat) plus the attached debugger's events;
// if the worker dies mid-run the run is abandoned in 'running' (full resume is
// a later milestone), which the panel surfaces rather than silently continuing.

import { ACT_MAX_ACTIONS_CEILING, ACT_MAX_ACTIONS_DEFAULT } from './schema.js';
import type { ActRunState } from './schema.js';
import { isRestrictedUrl, originOf } from './actGate.js';
import { detach, ensureAttached, hasDebuggerPermission } from './cdp.js';
import { buildActTools, buildSteeringPrompt, buildWorkflowRunPrompt, type ActContext } from './actTools.js';
import { appendTranscript, clearActRun, mutateActRun, startActRun } from './actStore.js';
import { runChatWithTools } from './providerClient.js';
import { readLocalBrain } from './brainStore.js';
import { getActHostAllow, getActRun, setActHostAllow } from './storage.js';
import type { WorkflowSpec } from '@nff-brain/core/workflow';

const ACT_MAX_TURNS = 24;

export type GrantChoice = 'once' | 'always' | 'never';

export interface StartResult {
  ok: boolean;
  runId?: string;
  /** Present when ok:false — short, user-showable. */
  error?: string;
  /** True when the run is parked on an origin grant the panel must answer. */
  awaitingGrant?: boolean;
}

function newRunId(): string {
  return `act_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function clampMax(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) return ACT_MAX_ACTIONS_DEFAULT;
  return Math.min(Math.floor(raw!), ACT_MAX_ACTIONS_CEILING);
}

/**
 * Begin a run against `tabId`. If the tab's origin is already "always"-granted
 * the loop starts immediately; otherwise the run parks in 'awaiting_grant' and
 * the panel prompts before any action. Reads/navigation never need a grant.
 */
/** Load a workflow spec from the local brain by its node id. */
async function loadWorkflow(workflowId: string): Promise<WorkflowSpec | null> {
  const brain = await readLocalBrain();
  const node = brain.nodes.find((n) => n.id === workflowId && n.origin === 'workflow');
  return node?.workflow ?? null;
}

export async function startActionRun(goal: string, tabId: number, maxActions?: number, workflowId?: string): Promise<StartResult> {
  if (!goal.trim()) return { ok: false, error: 'enter a goal first' };
  if (!(await hasDebuggerPermission())) return { ok: false, error: 'the debugger permission is missing — remove and reload the extension' };
  if (workflowId && !(await loadWorkflow(workflowId))) return { ok: false, error: 'that workflow is no longer in your brain' };

  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    return { ok: false, error: 'that tab is no longer open' };
  }
  if (isRestrictedUrl(url)) return { ok: false, error: 'the agent cannot act on this page (browser-internal or restricted)' };

  const origin = originOf(url);
  const persisted = origin ? (await getActHostAllow()).byOrigin[origin] : undefined;
  if (persisted === 'never') return { ok: false, error: `you set ${origin} to never allow actions` };

  const now = new Date().toISOString();
  const grantedNow = persisted === 'always' && origin ? [origin] : [];
  const awaitingGrant = persisted !== 'always';
  const run: ActRunState = {
    id: newRunId(),
    phase: awaitingGrant ? 'awaiting_grant' : 'running',
    goal: goal.trim(),
    workflowId,
    tabId,
    actionsTaken: 0,
    maxActions: clampMax(maxActions),
    grantedOrigins: grantedNow,
    pendingGrant: awaitingGrant ? { origin: origin ?? '', verbClass: 'interact' } : null,
    transcript: [{ at: now, kind: 'system', text: `Goal: ${goal.trim()}` }],
    startedAt: now,
    updatedAt: now,
  };
  await startActRun(run);

  if (!awaitingGrant) void drive(run.id, tabId);
  return { ok: true, runId: run.id, awaitingGrant };
}

/** Answer the pending origin grant. 'never' ends the run; else the loop starts. */
export async function grantOrigin(choice: GrantChoice): Promise<void> {
  const run = await getActRun();
  if (!run || run.phase !== 'awaiting_grant' || !run.pendingGrant) return;
  const origin = run.pendingGrant.origin;

  if (choice === 'always' || choice === 'never') {
    const state = await getActHostAllow();
    state.byOrigin[origin] = choice;
    await setActHostAllow(state);
  }

  if (choice === 'never') {
    await mutateActRun((r) => {
      r.phase = 'stopped';
      r.pendingGrant = null;
      r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: `Denied ${origin}. Run stopped.` });
    });
    return;
  }

  const updated = await mutateActRun((r) => {
    if (choice === 'once' && origin && !r.grantedOrigins.includes(origin)) r.grantedOrigins.push(origin);
    r.pendingGrant = null;
    r.phase = 'running';
    r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: `Allowed ${origin}. Starting.` });
  });
  if (updated) void drive(updated.id, updated.tabId);
}

/** Request a graceful stop — the loop finalizes after the current turn. */
export async function stopActionRun(): Promise<void> {
  await mutateActRun((r) => {
    if (r.phase === 'running' || r.phase === 'awaiting_grant') {
      r.phase = 'stopping';
      r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: 'Stop requested.' });
    }
  });
}

/** Detach the debugger and drop the run record. */
export async function endActionRun(): Promise<void> {
  const run = await getActRun();
  if (run) await detach(run.tabId);
  await clearActRun();
}

async function drive(runId: string, tabId: number): Promise<void> {
  const run = await getActRun();
  if (!run || run.id !== runId || run.phase !== 'running') return;

  const ctx: ActContext = {
    tabId,
    actionsTaken: run.actionsTaken,
    maxActions: run.maxActions,
    grantedOrigins: [...run.grantedOrigins],
    stopped: false,
  };

  try {
    await ensureAttached(tabId);
  } catch (err) {
    await mutateActRun((r) => {
      r.phase = 'error';
      r.error = err instanceof Error ? err.message : 'could not attach the debugger';
    });
    return;
  }

  // Replaying a workflow steers with its generalized steps; a free goal steers plainly.
  let prompt = buildSteeringPrompt(run.goal);
  if (run.workflowId) {
    const spec = await loadWorkflow(run.workflowId);
    if (spec) prompt = buildWorkflowRunPrompt(spec, run.goal);
  }

  const result = await runChatWithTools(prompt, buildActTools(ctx), {
    maxTurns: ACT_MAX_TURNS,
    onTurn: async () => {
      const cur = await getActRun();
      if (!cur || cur.id !== runId || cur.phase === 'stopping' || cur.phase === 'stopped') {
        ctx.stopped = true;
        return false;
      }
      if (ctx.actionsTaken >= ctx.maxActions) return false;
      return true;
    },
  });

  if (result === null) {
    await mutateActRun((r) => {
      r.phase = 'error';
      r.error = 'add an API key in Settings to run the agent';
    });
    await detach(tabId);
    return;
  }

  if (result.answer) await appendTranscript({ kind: 'thought', text: result.answer });
  await mutateActRun((r) => {
    if (r.phase === 'running' || r.phase === 'stopping') r.phase = ctx.stopped || r.phase === 'stopping' ? 'stopped' : 'done';
  });
  await detach(tabId);
}
