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
import {
  buildActTools,
  buildPairedActPrompt,
  buildSteeringPrompt,
  buildWorkflowRunPrompt,
  parseActAction,
  runActByName,
  type ActContext,
} from './actTools.js';
import { appendTranscript, clearActRun, mutateActRun, startActRun } from './actStore.js';
import { runChatWithTools } from './providerClient.js';
import { postActStep } from './client.js';
import { readLocalBrain } from './brainStore.js';
import { getActHostAllow, getActRun, getPairing, setActHostAllow } from './storage.js';
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

  const workflow = run.workflowId ? await loadWorkflow(run.workflowId) : null;

  // Attach directly to the tab the side panel targeted — the window's ACTIVE
  // tab. Unlike the DevTools-inspected tab (where open DevTools already holds
  // the single debugger slot, so attach fails), the active tab beside a side
  // panel keeps its slot free, so the cursor moves in the very page the user is
  // looking at. A workflow replay just navigates there itself.
  try {
    await ensureAttached(tabId);
  } catch (err) {
    await mutateActRun((r) => {
      r.phase = 'error';
      r.error = err instanceof Error
        ? `could not attach to this tab (${err.message}) — if DevTools is open on it, close DevTools and use the side panel`
        : 'could not attach to this tab';
    });
    return;
  }

  const ctx: ActContext = {
    tabId,
    actionsTaken: run.actionsTaken,
    maxActions: run.maxActions,
    grantedOrigins: [...run.grantedOrigins],
    stopped: false,
  };

  // Replaying a workflow steers with its generalized steps; a free goal steers plainly.
  const prompt = workflow ? buildWorkflowRunPrompt(workflow, run.goal) : buildSteeringPrompt(run.goal);

  // PAIRED wins: drive the loop through the local server's `claude -p` (the
  // user's Claude Code login — no API key). Only if unpaired do we fall back to
  // the BYOK Anthropic tool-use loop.
  const pairing = await getPairing();
  const outcome = pairing
    ? await runPairedLoop(ctx, runId, prompt, pairing.port, pairing.token)
    : await runByokLoop(ctx, runId, prompt);

  if (!outcome.ok) {
    await mutateActRun((r) => {
      r.phase = 'error';
      r.error = outcome.error;
    });
    await detach(tabId);
    return;
  }

  if (outcome.answer) await appendTranscript({ kind: 'thought', text: outcome.answer });
  await mutateActRun((r) => {
    if (r.phase === 'running' || r.phase === 'stopping') r.phase = ctx.stopped || r.phase === 'stopping' ? 'stopped' : 'done';
  });
  await detach(tabId);
}

type LoopOutcome = { ok: true; answer: string } | { ok: false; error: string };

/** Between-turns checkpoint shared by both loops: honor Stop and the action budget. */
async function keepGoing(ctx: ActContext, runId: string): Promise<boolean> {
  const cur = await getActRun();
  if (!cur || cur.id !== runId || cur.phase === 'stopping' || cur.phase === 'stopped') {
    ctx.stopped = true;
    return false;
  }
  if (ctx.actionsTaken >= ctx.maxActions) return false;
  return true;
}

/** BYOK Anthropic tool-use loop (standalone / unpaired). */
async function runByokLoop(ctx: ActContext, runId: string, prompt: string): Promise<LoopOutcome> {
  const result = await runChatWithTools(prompt, buildActTools(ctx), {
    maxTurns: ACT_MAX_TURNS,
    onTurn: () => keepGoing(ctx, runId),
  });
  if (result === null) return { ok: false, error: 'pair a local nff-brain server, or add an API key in Settings, to run the agent' };
  return { ok: true, answer: result.answer };
}

/**
 * Paired loop: each turn, send the assembled prompt (steering + contract +
 * action history) to /v1/act/step (the server runs `claude -p`), parse ONE JSON
 * action from the reply, run it through the SAME gate+engine the BYOK executors
 * use, append the result, repeat. History is bounded so the prompt stays sane.
 */
async function runPairedLoop(ctx: ActContext, runId: string, systemPrompt: string, port: number, token: string): Promise<LoopOutcome> {
  const snapshotIdRef = { id: '' };
  const history: string[] = [];
  let answer = '';

  for (let turn = 0; turn < ACT_MAX_TURNS; turn++) {
    if (!(await keepGoing(ctx, runId))) break;

    let text: string;
    try {
      text = await postActStep(port, token, buildPairedActPrompt(systemPrompt, history));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'the local server did not answer' };
    }

    const action = parseActAction(text);
    if (action.kind === 'done') {
      answer = action.summary;
      break;
    }
    if (action.kind === 'invalid') {
      history.push('> (your last reply was not a single JSON action — reply with exactly one JSON object)');
      continue;
    }

    const res = await runActByName(ctx, action.name, action.args, snapshotIdRef);
    history.push(`> ${JSON.stringify({ action: action.name, args: action.args }).slice(0, 400)}`);
    history.push(`= ${res.resultText.slice(0, 6000)}`);
    // Keep the transcript sent to claude -p bounded — the latest read_page is
    // what carries the current refs, older entries are just breadcrumbs.
    while (history.length > 16) history.shift();
  }

  return { ok: true, answer };
}
