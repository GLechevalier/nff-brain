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
  actContractTools,
  buildActSystemPrompt,
  buildActTools,
  buildActUserGoal,
  buildPairedActPrompt,
  buildSessionStepMessage,
  buildSteeringPrompt,
  buildWorkflowRunPrompt,
  parseActAction,
  runActByName,
  type ActContext,
  type ActDelta,
} from './actTools.js';
import { appendTranscript, clearActRun, mutateActRun, startActRun } from './actStore.js';
import { runChatWithTools } from './providerClient.js';
import { ProviderError } from '@nff-brain/core/provider';
import { resolveBrainMode } from './mode.js';
import { getLocalWorkflow, upsertWorkflow } from './workflowStore.js';
import { readLocalBrain } from './brainStore.js';
import { fuseRanked } from '@nff-brain/core/rank';
import { HttpError, getWorkflow, postActSessionEnd, postActSessionStep, postActStep } from './client.js';
import { getActHostAllow, getActRun, getCodeProject, getPairing, setActHostAllow } from './storage.js';
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
/** Load a workflow spec LOCAL-FIRST (nb.workflows — how BYOK replays with no
 *  server, and one less network round trip on paired replay start); on a
 *  local miss, fall back to the paired server and cache what it returns. */
async function loadWorkflow(workflowId: string): Promise<WorkflowSpec | null> {
  const local = await getLocalWorkflow(workflowId);
  if (local) return local.spec;
  const pairing = await getPairing();
  if (!pairing) return null;
  try {
    const full = await getWorkflow(pairing.port, pairing.token, workflowId);
    void upsertWorkflow({
      id: workflowId,
      title: full.title,
      intent: full.spec.intent,
      site: full.spec.site,
      params: full.spec.params.map((p) => p.name),
      spec: full.spec,
      savedAt: new Date().toISOString(),
      source: 'server',
    });
    return full.spec;
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
  codeEnabled = false,
): Promise<StartResult> {
  if (!goal.trim()) return { ok: false, error: 'enter a goal first' };
  if (!(await hasDebuggerPermission())) return { ok: false, error: 'the debugger permission is missing — remove and reload the extension' };
  if (workflowId && !(await loadWorkflow(workflowId))) {
    return {
      ok: false,
      error: (await getPairing())
        ? 'that workflow is no longer in your brain'
        : 'that workflow is not saved locally — record a task, or pair to import your saved workflows',
    };
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
    // codeEnabled only sticks when a project is actually attached — a stale
    // checkbox without a folder would advertise tools that can only fail.
    codeEnabled: codeEnabled && !!(await getCodeProject()),
    codeGrants: {},
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

  // Coding-agent approvals ride the same mid-run path as 'capability': a
  // paused codeTools executor (requestCodeGrant) is waiting on the choice —
  // post it and let that call resume itself. Never ends the run: a declined
  // write/command is a tool result the model narrates, not a stop.
  if (run.pendingGrant.kind === 'code-write' || run.pendingGrant.kind === 'code-exec') {
    const g = run.pendingGrant;
    const label = g.kind === 'code-write' ? `write ${g.path}` : `run ${g.command}`;
    const verb = { once: 'Allowed', always: 'Always allowed', never: 'Declined' }[choice];
    await mutateActRun((r) => {
      if (choice === 'always') r.codeGrants = { ...(r.codeGrants ?? {}), [g.kind === 'code-write' ? 'write' : 'exec']: true };
      r.pendingGrant = null;
      r.pendingGrantChoice = choice;
      r.phase = 'running';
      r.transcript.push({ at: new Date().toISOString(), kind: 'system', text: `${verb}: ${label}.` });
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

/**
 * The panel's per-run auto-approve toggle for code writes/commands. Mutating
 * nb.actRun (not a ctx mirror) is what makes it take effect on the very next
 * action — codeTools reads the grants fresh at each gate decision.
 */
export async function setCodeAutoApprove(enabled: boolean): Promise<void> {
  await mutateActRun((r) => {
    r.codeGrants = enabled ? { write: true, exec: true } : {};
  });
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
    codeEnabled: !!run.codeEnabled,
  };

  // Code-enabled runs steer with the project's name so the model knows whose
  // files it is touching (codeTools.ts's steering paragraph).
  const codeName = run.codeEnabled ? ((await getCodeProject())?.name ?? 'project') : null;

  // Which brain drives the loop is the user's explicit choice now (mode.ts) —
  // default preserves the old rule (a stored pairing wins). Paired routes
  // through the local server's `claude -p`; BYOK talks straight to the
  // provider API and needs neither a server nor Claude Code on the machine.
  const mode = await resolveBrainMode();
  let outcome: LoopOutcome;
  if (mode === 'paired') {
    const pairing = await getPairing();
    // Replaying a workflow steers with its generalized steps; a free goal steers plainly.
    const prompt = workflow ? buildWorkflowRunPrompt(workflow, run.goal) : buildSteeringPrompt(run.goal, codeName);
    outcome = pairing
      ? await runPairedLoop(ctx, runId, prompt, pairing.port, pairing.token)
      : { ok: false, error: 'pairing is gone — re-pair from the Settings tab, or switch to your API key' };
  } else if (mode === 'byok') {
    outcome = await runByokLoop(ctx, runId, run.goal, workflow, codeName);
  } else {
    outcome = { ok: false, error: 'pair a local nff-brain server, or add an API key in Settings, to run the agent' };
  }

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
function watchForStop(runId: string, stopPhasesOnly = false): { promise: Promise<void>; cancel: () => void } {
  let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const promise = new Promise<void>((resolve) => {
    listener = (changes, area) => {
      if (area !== 'local' || !(KEYS.actRun in changes)) return;
      const v = changes[KEYS.actRun]!.newValue as ActRunState | null | undefined;
      const gone = !v || v.id !== runId;
      // stopPhasesOnly is for a watcher armed across a WHOLE run (the BYOK
      // loop's abort signal): Manual mode legitimately parks the phase in
      // 'awaiting_grant' mid-run while a tool waits for consent, and that
      // must not read as Stop. The paired loop arms per server call — where
      // any departure from 'running' is a stop — and keeps the strict check.
      const decided = stopPhasesOnly ? gone || v.phase === 'stopping' || v.phase === 'stopped' : gone || v.phase !== 'running';
      if (decided) resolve();
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

/**
 * Reasoning policy for the BYOK act loop, deliberately two constants:
 * thinking OFF because a tightly-steered tool loop pays adaptive-thinking
 * latency every turn for no benefit (flip to 'adaptive' if step quality
 * regresses), and a tight max_tokens because a turn is one tool call plus a
 * sentence — it bounds tail latency without cramping the final summary.
 */
const ACT_THINKING: 'disabled' | 'adaptive' = 'disabled';
const ACT_MAX_TOKENS = 2048;

/**
 * BYOK Anthropic tool-use loop — direct provider API, no server, no Claude
 * Code. Speed levers live in the opts: the static run prefix (steering +
 * workflow) rides in `system` so the adapter can prompt-cache it, superseded
 * read_page snapshots get compacted, and the whole-run abort signal makes
 * Stop preempt an in-flight model call instead of waiting out its 45s.
 */
const ACT_BRAIN_CONTEXT_LIMIT = 4;
const ACT_BRAIN_EXCERPT_MAX = 300;

/**
 * Rank the LOCAL brain against the goal, once per run — the result rides in
 * the cached system prefix so it costs zero tokens per turn. Empty brain (or
 * any failure) simply means no context; the run must never die on this.
 */
async function buildBrainContext(goal: string): Promise<string | undefined> {
  try {
    const brain = await readLocalBrain();
    if (brain.nodes.length === 0) return undefined;
    const ranked = fuseRanked(goal, brain.nodes, null, { limit: ACT_BRAIN_CONTEXT_LIMIT });
    if (ranked.length === 0) return undefined;
    const lines = ranked.map((r) => {
      const text = (r.node.content ?? '').replace(/\s+/g, ' ').trim().slice(0, ACT_BRAIN_EXCERPT_MAX);
      return `- ${r.node.title}: ${text}`;
    });
    return `BRAIN CONTEXT (notes the user saved earlier that may help):\n${lines.join('\n')}`;
  } catch {
    return undefined;
  }
}

/** Floor between live-thought transcript writes — every nb.actRun write fans
 *  out to the panel's storage.onChanged listener, so unthrottled deltas would
 *  thrash it. 250ms still reads as live. */
const LIVE_THOUGHT_FLUSH_MS = 250;

async function runByokLoop(ctx: ActContext, runId: string, goal: string, workflow: WorkflowSpec | null, codeName: string | null): Promise<LoopOutcome> {
  const controller = new AbortController();
  const watch = watchForStop(runId, true);
  void watch.promise.then(() => controller.abort());

  // Streaming: deltas accumulate into ONE mutable 'thought' transcript entry
  // (found again by its `at` stamp) instead of appending per fragment. The
  // turn-complete onAssistantText below is the finalize signal — it writes
  // the settled text once more and resets for the next turn, so the streamed
  // thought is never duplicated.
  let liveText = '';
  let liveAt: string | null = null;
  let lastFlush = 0;
  const flushLive = (): Promise<unknown> =>
    mutateActRun((r) => {
      if (liveAt === null) liveAt = new Date().toISOString();
      const at = liveAt;
      const entry = r.transcript.find((e) => e.at === at && e.kind === 'thought');
      if (entry) entry.text = liveText;
      else r.transcript.push({ at, kind: 'thought', text: liveText });
    });

  try {
    const result = await runChatWithTools(buildActUserGoal(goal, workflow), buildActTools(ctx), {
      maxTurns: ACT_MAX_TURNS,
      system: buildActSystemPrompt(workflow, codeName, await buildBrainContext(goal)),
      thinking: ACT_THINKING,
      maxTokens: ACT_MAX_TOKENS,
      signal: controller.signal,
      compactToolNames: ['read_page'],
      onTurn: () => keepGoing(ctx, runId),
      onAssistantTextDelta: (t) => {
        liveText += t;
        const now = Date.now();
        if (now - lastFlush >= LIVE_THOUGHT_FLUSH_MS) {
          lastFlush = now;
          void flushLive();
        }
      },
      onAssistantText: (text) => {
        // Finalize the streamed entry with the settled text, then reset for
        // the next turn. If streaming never fired (adapter fallback), this
        // still lands the thought — same one-entry-per-turn shape either way.
        liveText = text;
        void flushLive().then(() => {
          liveAt = null;
          liveText = '';
          lastFlush = 0;
        });
      },
      // SW-console only — how a dead prompt cache shows up (cache_read stuck
      // at 0 while input_tokens climbs) instead of silently costing full price.
      onUsage: (u) => console.debug('[nff-brain act] usage', u),
    });
    if (result === null) return { ok: false, error: 'pair a local nff-brain server, or add an API key in Settings, to run the agent' };
    return { ok: true, answer: result.answer };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'aborted') {
      ctx.stopped = true;
      return { ok: true, answer: '' };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'the provider did not answer' };
  } finally {
    watch.cancel();
  }
}

/**
 * Paired loop: each turn, ask the server for ONE JSON action, run it through
 * the SAME gate+engine the BYOK executors use, append the result, repeat.
 *
 * Transport, fast path first: /v1/act/session/step keeps ONE warm `claude`
 * process per run server-side (only this turn's delta is new tokens; the full
 * prompt rides along as respawn fuel). A 404 means an older server without
 * that route — fall back to stateless /v1/act/step (a fresh `claude -p` per
 * turn, the pre-session behavior) for the rest of the run.
 * History is bounded so the bootstrap/legacy prompt stays sane.
 */
async function runPairedLoop(ctx: ActContext, runId: string, systemPrompt: string, port: number, token: string): Promise<LoopOutcome> {
  const snapshotIdRef = { id: '' };
  const history: string[] = [];
  let answer = '';
  let sessionMode = true;
  let lastDelta: ActDelta = null;

  for (let turn = 0; turn < ACT_MAX_TURNS; turn++) {
    if (!(await keepGoing(ctx, runId))) break;

    const bootstrap = buildPairedActPrompt(systemPrompt, history, actContractTools(ctx.codeEnabled));
    const stepCall = sessionMode
      ? postActSessionStep(port, token, runId, bootstrap, buildSessionStepMessage(lastDelta)).catch((err) => {
          // Old server without the session route — one cheap probe miss, then
          // this whole run stays on the legacy path. That miss arrives in TWO
          // shapes: an honest 404 (server new enough to answer preflights on
          // unknown routes), or status 0 'network' (older servers 404 the
          // CORS preflight itself with no CORS headers, which Chrome reports
          // as an opaque fetch failure). Falling back on 'network' is safe:
          // if the server is truly down the legacy call fails identically.
          // 'timeout' must NOT fall back — the route exists, claude is slow.
          if (err instanceof HttpError && (err.status === 404 || (err.status === 0 && err.code === 'network'))) {
            sessionMode = false;
            return postActStep(port, token, bootstrap);
          }
          throw err;
        })
      : postActStep(port, token, bootstrap);
    // Never throws — a rejection settles as {kind:'error'} so the promise
    // always fulfills, even if the stop-watcher below wins the race first
    // (otherwise a later rejection with no .catch would surface as an
    // unhandled promise rejection in the service worker).
    const stepSettled = stepCall.then(
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
      lastDelta = 'invalid';
      continue;
    }

    const res = await runActByName(ctx, action.name, action.args, snapshotIdRef);
    const actionStr = JSON.stringify({ action: action.name, args: action.args }).slice(0, 400);
    history.push(`> ${actionStr}`);
    history.push(`= ${res.resultText.slice(0, 6000)}`);
    lastDelta = { action: actionStr, result: res.resultText };
    // Keep the transcript sent to claude -p bounded — the latest read_page is
    // what carries the current refs, older entries are just breadcrumbs.
    while (history.length > 16) history.shift();
  }

  // Let the server retire the warm claude process now rather than waiting out
  // its idle timer (which remains the backstop if the SW dies mid-run).
  if (sessionMode) void postActSessionEnd(port, token, runId);
  return { ok: true, answer };
}
