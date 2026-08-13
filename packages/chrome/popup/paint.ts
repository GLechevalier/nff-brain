// (state) => mutate the static skeleton in popup.html.
//
// Only textContent, classList and the children of #rules are touched. The
// domain input is NEVER re-rendered, which is what keeps the caret in place
// while you type — the actual cost of hand-rolled DOM, avoided without a
// virtual DOM for six controls.

import { relativeAge } from '../src/health.js';
import { ruleLabel } from '../src/gate.js';
import type { PublicState } from '../src/protocol.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const PHASE_TEXT: Record<PublicState['phase'], string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  rejected: 'Pairing expired',
  unpaired: 'Not paired',
  standalone: 'Standalone',
};

export interface PaintDeps {
  /** Host of the active tab, or null when the extension cannot see it. */
  currentHost: string | null;
  onRemoveRule: (host: string) => void;
  onToggleRecorder: (id: string, enable: boolean) => void;
}

export function paint(state: PublicState, deps: PaintDeps, nowMs = Date.now()): void {
  const { phase, health } = state;

  // ── connection ────────────────────────────────────────────────────────────
  $('dot').className = `dot ${phase}`;
  $('phase').textContent = PHASE_TEXT[phase];
  $('endpoint').textContent = state.port ? `127.0.0.1:${state.port}` : '';
  $('version').textContent = health.serverVersion ? `v${health.serverVersion}` : '';

  const counts =
    phase === 'standalone'
      ? `${state.standaloneNodes ?? 0} local note${(state.standaloneNodes ?? 0) === 1 ? '' : 's'} · your API key`
      : health.projectNodes === null
        ? ''
        : `${health.projectNodes} project · ${health.globalNodes ?? 0} global nodes`;
  const age = relativeAge(health.lastOkAt, nowMs);
  // Showing last-known numbers WITH their age is honest in both phases; showing
  // them bare while disconnected is not.
  $('counts').textContent =
    counts && (phase === 'connected' || phase === 'standalone' ? counts : age ? `${counts}, as of ${age}` : counts);
  $('workspace').textContent = health.workspaceRoot ?? '';

  const showError = phase !== 'connected' && phase !== 'standalone' && !!health.lastError;
  $('conn-error').textContent = health.lastError ?? '';
  $('conn-error').classList.toggle('hidden', !showError);
  $('retry').classList.toggle('hidden', phase !== 'disconnected');

  $('migration').textContent =
    state.migrationPending !== null
      ? `Moving ${state.migrationPending} standalone note${state.migrationPending === 1 ? '' : 's'} into your local brain…`
      : '';
  $('migration').classList.toggle('hidden', state.migrationPending === null);

  // Standalone keeps the pair form reachable — pairing is the doorway to
  // migrating the local brain into a real server.
  const needsPairing = phase === 'unpaired' || phase === 'rejected' || phase === 'standalone';
  $('pair-form').classList.toggle('hidden', !needsPairing);
  ($('connect') as HTMLButtonElement).textContent = phase === 'rejected' ? 'Re-pair' : 'Connect';

  // ── capture ───────────────────────────────────────────────────────────────
  const toggle = $('capture-toggle');
  toggle.setAttribute('aria-checked', String(state.capture.enabled));
  $('capture-hint').textContent = state.capture.enabled
    ? 'Right-click any selected text → “Remember this”.'
    : "Capture is paused. Nothing is recorded, on any domain.";

  // ── allowlist ─────────────────────────────────────────────────────────────
  const list = $('rules');
  list.replaceChildren(
    ...state.rules.map((rule) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = ruleLabel(rule);
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = `Remove ${rule.host}`;
      remove.addEventListener('click', () => deps.onRemoveRule(rule.host));
      li.append(label, remove);
      return li;
    }),
  );
  $('rule-count').textContent = state.rules.length ? String(state.rules.length) : '';
  $('rules-empty').classList.toggle('hidden', state.rules.length > 0);

  const allowCurrent = $<HTMLButtonElement>('allow-current');
  const known = deps.currentHost && !state.rules.some((r) => r.host === deps.currentHost);
  allowCurrent.classList.toggle('hidden', !known);
  if (known) allowCurrent.textContent = `+ Allow ${deps.currentHost}`;

  // ── recorders ─────────────────────────────────────────────────────────────
  $('recorders').replaceChildren(
    ...state.recorders.map((rec) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = rec.label;
      const status = document.createElement('span');
      status.className = 'muted small';
      status.textContent = !rec.enabled
        ? ''
        : !state.capture.enabled
          ? ' · paused — capture is off'
          : !rec.allowlisted
            ? ` · blocked — re-add ${rec.hosts[0]}`
            : !rec.granted
              ? ' · blocked — permission missing'
              : ' · recording';
      const btn = document.createElement('button');
      btn.textContent = rec.enabled ? 'Disable' : 'Enable';
      btn.title = rec.enabled ? `Stop recording on ${rec.hosts.join(', ')}` : `Ask Chrome for ${rec.hosts.join(', ')}`;
      btn.addEventListener('click', () => deps.onToggleRecorder(rec.id, !rec.enabled));
      li.append(label, status, btn);
      return li;
    }),
  );

  // ── activity ──────────────────────────────────────────────────────────────
  const n = state.activityCount;
  $('activity-count').textContent = n ? `${n} item${n === 1 ? '' : 's'}` : '';
  const clear = $<HTMLButtonElement>('clear');
  clear.disabled = n === 0;
  clear.textContent = n === 0 ? 'Nothing captured yet' : 'Clear activity history…';
}

/** The confirm step, rendered only with numbers it can actually stand behind. */
export function paintClearConfirm(state: PublicState): void {
  const removable = state.removableNodeCount;
  $('clear-question').textContent = `Clear ${state.activityCount} buffered item${
    state.activityCount === 1 ? '' : 's'
  }?`;
  // NO CHECKBOX when nothing is traceable. A checkbox that cannot do anything
  // is worse than no feature — and until a drain reports clip→node mappings,
  // that is always the case.
  $('clear-nodes-row').classList.toggle('hidden', removable === 0);
  $('clear-nodes-label').textContent = `Also delete the ${removable} brain node${
    removable === 1 ? '' : 's'
  } still traceable to this activity`;
  ($('clear-nodes') as HTMLInputElement).checked = false;
  $('clear-confirm').classList.remove('hidden');
}

export function hideClearConfirm(): void {
  $('clear-confirm').classList.add('hidden');
}

export function showFieldError(id: string, message: string | null): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('hidden', !message);
}
