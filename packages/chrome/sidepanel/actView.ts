// Pure DOM renderers for the web-agent side panel — no chrome.*, same
// separation as popup/paint.ts. Transcript text goes through textContent, never
// innerHTML: page content the agent read back is data, not markup.

import type { ActRunState } from '../src/schema.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const ACT_PHASE_LABEL: Record<string, string> = {
  running: 'Running',
  awaiting_grant: 'Waiting for your permission',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  done: 'Done',
  error: 'Error',
};

export function paintActRun(run: ActRunState | null): void {
  const idle = run === null;
  const phase = run?.phase ?? null;
  const running = phase === 'running' || phase === 'stopping' || phase === 'awaiting_grant';

  ($('act-goal') as HTMLTextAreaElement).disabled = running;
  ($('act-budget') as HTMLInputElement).disabled = running;
  $('act-start').classList.toggle('hidden', running);
  $('act-stop').classList.toggle('hidden', !running);
  $('act-grant').classList.toggle('hidden', phase !== 'awaiting_grant');
  $('act-clear').classList.toggle('hidden', idle || running);

  const status = $('act-status');
  status.textContent = idle
    ? ''
    : `${ACT_PHASE_LABEL[phase ?? ''] ?? phase} · ${run!.actionsTaken}/${run!.maxActions} actions` +
      (run!.error ? ` · ${run!.error}` : '');
  status.classList.toggle('error', phase === 'error');

  if (phase === 'awaiting_grant' && run?.pendingGrant) {
    $('act-grant-origin').textContent = run.pendingGrant.origin || 'this site';
  }

  const log = $('act-log');
  log.innerHTML = '';
  for (const e of run?.transcript ?? []) {
    const row = document.createElement('div');
    row.className = `act-line act-${e.kind}${e.ok === false ? ' bad' : ''}`;
    row.textContent = e.text;
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

export interface WorkflowRow {
  id: string;
  title: string;
  intent: string;
  site: string;
  params: string[];
}

export function renderWorkflows(items: WorkflowRow[], onRun: (w: WorkflowRow) => void): void {
  const list = $('workflow-list');
  list.innerHTML = '';
  $('workflow-empty').classList.toggle('hidden', items.length > 0);
  for (const w of items) {
    const li = document.createElement('li');
    li.className = 'row';
    const info = document.createElement('div');
    info.className = 'grow';
    const title = document.createElement('div');
    title.className = 'small strong';
    title.textContent = w.title;
    const meta = document.createElement('div');
    meta.className = 'muted small';
    meta.textContent = w.params.length ? `${w.site} · ${w.params.join(', ')}` : w.site;
    info.append(title, meta);
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = 'Run';
    btn.addEventListener('click', () => onRun(w));
    li.append(info, btn);
    list.appendChild(li);
  }
}

export function showError(msg: string | null): void {
  const el = $('act-error');
  el.textContent = msg ?? '';
  el.classList.toggle('hidden', !msg);
}
