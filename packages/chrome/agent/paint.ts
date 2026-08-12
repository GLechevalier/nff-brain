// (state) => mutate the static skeleton in agent.html. Same discipline as
// popup/paint.ts: only textContent, classList and list children are touched.

import type { ActionRecord, McpServerSummary, McpToolDef, PlanStep, PublicState, WebAgentRun } from '../src/protocol.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const PHASE_TEXT: Record<WebAgentRun['phase'], string> = {
  planning: 'Planning…',
  awaiting_approval: 'Plan ready — review below',
  running: 'Running',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  done: 'Done',
  error: 'Error',
};

export function paintAdapter(state: PublicState): void {
  const linkedin = state.agentAdapters.find((a) => a.id === 'linkedin');
  const btn = $<HTMLButtonElement>('adapter-toggle');
  if (!linkedin) {
    btn.disabled = true;
    return;
  }
  btn.textContent = linkedin.enabled ? 'Disable' : 'Enable';
  btn.title = linkedin.enabled
    ? `Stop the agent acting on ${linkedin.hosts.join(', ')}`
    : `Ask Chrome for ${linkedin.hosts.join(', ')}`;
}

function planStepLine(step: PlanStep, index: number): HTMLLIElement {
  const li = document.createElement('li');
  const summary = document.createElement('span');
  summary.textContent = `${index + 1}. ${step.summary}`;
  li.append(summary);
  return li;
}

/** Only meaningful while phase === 'awaiting_approval' — callers gate visibility. */
export function paintPlan(run: WebAgentRun): void {
  const plan = run.plan;
  $('plan-summary').textContent = plan
    ? `Up to ${plan.maxActions} connect(s). Criteria: ${plan.criteria || '(none stated)'}`
    : '';
  $('plan-steps').replaceChildren(...(plan?.steps.map(planStepLine) ?? []));
}

function historyLine(record: ActionRecord): HTMLLIElement {
  const li = document.createElement('li');
  const summary = document.createElement('span');
  const ok = record.result?.ok;
  const mark = ok === undefined ? '…' : ok ? '✓' : '✗';
  summary.textContent = `${mark} ${record.verb} — ${record.result?.summary ?? '(pending)'}`;
  const when = document.createElement('span');
  when.className = 'muted small';
  when.textContent = new Date(record.requestedAt).toLocaleTimeString();
  li.append(summary, when);
  if (record.result?.listWriteError) {
    const warn = document.createElement('span');
    warn.className = 'error small';
    warn.textContent = `list write failed: ${record.result.listWriteError}`;
    li.append(warn);
  }
  return li;
}

export function paintRun(run: WebAgentRun): void {
  $('run-phase').textContent = PHASE_TEXT[run.phase];
  $('run-progress').textContent = `${run.actionsTaken}/${run.maxActions} connected`;
  $('run-goal').textContent = run.goal;
  $('run-error').textContent = run.error ?? '';
  $('run-error').classList.toggle('hidden', !run.error);
  $('run-history').replaceChildren(...[...run.history].reverse().map(historyLine));

  const stop = $<HTMLButtonElement>('run-stop');
  stop.disabled = run.phase !== 'running' && run.phase !== 'stopping' && run.phase !== 'awaiting_approval' && run.phase !== 'planning';
}

export type PanelMode = 'goal' | 'plan' | 'run';

/** Which panel is visible is a pure function of the run's phase (or its absence). */
export function panelModeFor(run: WebAgentRun | null): PanelMode {
  if (!run) return 'goal';
  if (run.phase === 'awaiting_approval') return 'plan';
  return 'run';
}

export function paintPanels(mode: PanelMode): void {
  $('goal-panel').classList.toggle('hidden', mode !== 'goal');
  $('plan-panel').classList.toggle('hidden', mode !== 'plan');
  $('run-panel').classList.toggle('hidden', mode !== 'run');
}

export function paintMcpServers(servers: McpServerSummary[], selected: string | null): void {
  const select = $<HTMLSelectElement>('list-server');
  select.replaceChildren(
    ...[{ id: '', name: '(none — skip the list step)', enabled: true }, ...servers].map((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.enabled ? s.name : `${s.name} (disabled)`;
      opt.disabled = s.id !== '' && !s.enabled;
      return opt;
    }),
  );
  if (selected !== null) select.value = selected;
}

export function paintMcpTools(tools: McpToolDef[], selected: string | null): void {
  const select = $<HTMLSelectElement>('list-tool');
  select.disabled = tools.length === 0;
  select.replaceChildren(
    ...tools.map((t) => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.description ? `${t.name} — ${t.description}` : t.name;
      return opt;
    }),
  );
  if (selected !== null) select.value = selected;
}

export function showFieldError(id: string, message: string | null): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('hidden', !message);
}
