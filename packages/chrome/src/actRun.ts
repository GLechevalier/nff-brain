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

import { ACT_MAX_ACTIONS_CEILING, ACT_MAX_ACTIONS_DEFAULT, KEYS } from './schema.js';
import type { ActRunState } from './schema.js';
import { isRestrictedUrl, originOf } from './actGate.js';
import { detach, ensureAttached, hasDebuggerPermission } from './cdp.js';
import { attentionConsumeStop, attentionHide, attentionShow, cursorHide } from './actEngine.js';
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
import { getWorkflow, postActStep } from './client.js';
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
/** Load a workflow spec from the paired brain by its node id. Recorded
 *  workflows require pairing — there is no local fallback store. */
async function loadWorkflow(workflowId: string): Promise<WorkflowSpec | null> {
  const pairing = await getPairing();
  if (!pairing) return null;
  try {
    return (await getWorkflow(pairing.port, pairing.token, workflowId)).spec;
  } catch {
    return null;
  }
}

export async function startActionRun(
  goal: string,
  tabId: number,
  maxActions?: number,
  workflowId?: string,
  mode: 'manual' | 'plan' | 'auto' = 'auto',
): Promise<StartResult> {
  if (!goal.trim()) return { ok: false, error: 'enter a goal first' };
  if (!(await hasDebuggerPermission())) return { ok: false, error: 'the debugger permission is missing — remove and reload the extension' };
  if (workflowId && !(await loadWorkflow(workflowId))) {
    return { ok: false, error: (await getPairing()) ? 'that workflow is no longer in your brain' : 'pair with `nff-brain serve` to replay saved workflows' };
  }

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
    mode,
    workflowId,
    tabId,
    actionsTaken: 0,
    maxActions: clampMax(maxActions),
    grantedOrigins: grantedNow,
    manualGrants: {},
    pendingGrant: awaitingGrant ? { kind: 'origin', origin: origin ?? '', verbClass: 'interact' } : null,
    pendingGrantChoice: null,
    transcript: [{ at: now, kind: 'system', text: `Goal: ${goal.trim()}` }],
    startedAt: now,
    updatedAt: now,
  };
  await startActRun(run);

  if (!awaitingGrant) void drive(run.id, tabId);
  return { ok: true, runId: run.id, awaitingGrant };
}

/**
 * Answer the current pendingGrant — either the origin grant asked before the
 * loop starts (unchanged behavior: 'never' ends the run, else drive() starts)
 * or, mid-run, Manual mode's per-capability grant a paused runVerb() call
 * (actTools.ts's requestGrant) is waiting on: this just posts the choice and
 * lets that waiting call resume itself, same as answering Stop.
 */
export async function answerPendingGrant(choice: GrantChoice): Promise<void> {
  const run = await getActRun();
  if (!run || run.phase !== 'awaiting_grant' || !run.pendingGrant) return;

  if (run.pendingGrant.kind === 'capability') {
    const { verbClass, description } = run.pendingGrant;
    const verb = { once: 'Allowed', always: 'Always allowed', never: 'Declined' }[choice];
    await mutateActRun((r) => {
      if (choice === 'always') r.manualGrants[verbClass] = true;
      r.pendingGrant = null;
      r.pendingGrantChoice = choice;
      r.phase = 'running';
      r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: `${verb}: ${description}.` });
    });
    return;
  }

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
  if (run) {
    await attentionHide(run.tabId);
    await cursorHide(run.tabId);
    await detach(run.tabId);
  }
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
  await attentionShow(tabId);

  const ctx: ActContext = {
    tabId,
    runId,
    mode: run.mode,
    actionsTaken: run.actionsTaken,
    maxActions: run.maxActions,
    grantedOrigins: [...run.grantedOrigins],
    manualGrants: { ...run.manualGrants },
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

  // detach ctx.tabId, not the closure's original `tabId` param — a tab.switch/
  // tab.open/tab.duplicate mid-run rebinds ctx.tabId to whichever tab ended up
  // attached, and that's the one to release.
  if (!outcome.ok) {
    await mutateActRun((r) => {
      r.phase = 'error';
      r.error = outcome.error;
    });
    await attentionHide(ctx.tabId);
    await cursorHide(ctx.tabId);
    await detach(ctx.tabId);
    return;
  }

  if (outcome.answer) await appendTranscript({ kind: 'thought', text: outcome.answer });
  await mutateActRun((r) => {
    if (r.phase === 'running' || r.phase === 'stopping') r.phase = ctx.stopped || r.phase === 'stopping' ? 'stopped' : 'done';
  });
  await attentionHide(ctx.tabId);
  await cursorHide(ctx.tabId);
  await detach(ctx.tabId);
}

type LoopOutcome = { ok: true; answer: string } | { ok: false; error: string };

/**
 * Watch nb.actRun for Stop (phase leaving 'running') via chrome.storage.onChanged
 * — event-driven, not polled — so a turn's server call can be preempted the
 * instant Stop is clicked instead of only being noticed once that call settles.
 * A single /v1/act/step round trip can legitimately take up to CHAT_TIMEOUT_MS
 * (95s): without this, Stop looked broken because it was only ever checked
 * BETWEEN turns (keepGoing()), so clicking it mid-call did nothing visible for
 * up to 95s. Call cancel() once the race is decided either way, or the listener
 * leaks for the rest of the run.
 */
function watchForStop(runId: string): { promise: Promise<void>; cancel: () => void } {
  let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const promise = new Promise<void>((resolve) => {
    listener = (changes, area) => {
      if (area !== 'local' || !(KEYS.actRun in changes)) return;
      const v = changes[KEYS.actRun]!.newValue as ActRunState | null | undefined;
      const stillRunning = !!v && v.id === runId && v.phase === 'running';
      if (!stillRunning) resolve();
    };
    chrome.storage.onChanged.addListener(listener);
  });
  return { promise, cancel: () => chrome.storage.onChanged.removeListener(listener) };
}

/**
 * Between-turns checkpoint shared by both loops: honor Stop (from the panel's
 * storage-based flag, OR the page's in-page Stop pill) and the action budget.
 */
async function keepGoing(ctx: ActContext, runId: string): Promise<boolean> {
  if (await attentionConsumeStop(ctx.tabId)) {
    await stopActionRun();
    ctx.stopped = true;
    return false;
  }
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
    onAssistantText: (text) => void appendTranscript({ kind: 'thought', text }),
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

    // Never throws — a rejection settles as {kind:'error'} so the promise
    // always fulfills, even if the stop-watcher below wins the race first
    // (otherwise a later rejection with no .catch would surface as an
    // unhandled promise rejection in the service worker).
    const stepSettled = postActStep(port, token, buildPairedActPrompt(systemPrompt, history)).then(
      (text) => ({ kind: 'text', text }) as const,
      (err) => ({ kind: 'error', err }) as const,
    );
    const watch = watchForStop(runId);
    const raced = await Promise.race([stepSettled, watch.promise.then(() => ({ kind: 'stop' }) as const)]);
    watch.cancel();

    if (raced.kind === 'stop') {
      ctx.stopped = true;
      break;
    }
    if (raced.kind === 'error') {
      return { ok: false, error: raced.err instanceof Error ? raced.err.message : 'the local server did not answer' };
    }
    const text = raced.text;
    // Prose the model wrote before its JSON action (its reasoning for this
    // step) — otherwise only the final {done:true,summary} survives anywhere.
    // Strip a trailing ``` / ```json code-fence opener (claude -p routinely
    // wraps its JSON reply in one) so that common case doesn't log a spurious
    // "```json" line with no actual reasoning in it.
    const braceIdx = text.indexOf('{');
    const prose = braceIdx > 0 ? text.slice(0, braceIdx).replace(/```\w*\s*$/, '').trim() : '';
    if (prose) void appendTranscript({ kind: 'thought', text: prose });

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
