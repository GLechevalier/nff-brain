// THE ONLY MODULE THAT TOUCHES chrome.storage.
//
// Reads are defensive: storage is on disk and can be corrupted, hand-edited, or
// written by an older/newer version of this extension. A bad read is treated as
// absent — the service worker must never throw on a cold start.
//
// There is deliberately NO read-through cache. The popup and the service worker
// are separate JS realms, so a cache in one would never see a write from the
// other; and a storage.local.get is sub-millisecond while this extension does
// perhaps ten a minute.

import { DEFAULT_DRAIN, DEFAULTS, KEYS } from './schema.js';
import type {
  ActHostAllow,
  ActivityRecord,
  ActRunState,
  BrainModePref,
  BrainSyncSettings,
  CodeProjectMeta,
  TraceActiveState,
  TracePending,
  Allowlist,
  Capture,
  DrainState,
  Health,
  MigrationBackup,
  Pairing,
  CrmSyncSettings,
  ProviderSettings,
  RecentClip,
  StandaloneBrain,
  StandaloneClip,
  StoredState,
  WorkflowStore,
} from './schema.js';
import type { RecorderSeenEntry, RecorderState } from './recorderTypes.js';
import type { NetLogEntry, PendingInvite } from './inviteNet.js';
import type { AgentActionAllowState, AgentAdapterState, AgentTabRef, NavigateHostAllowState } from './agentTypes.js';

async function raw<T>(key: string, fallback: T, valid: (v: unknown) => boolean): Promise<T> {
  try {
    const got = await chrome.storage.local.get(key);
    const v = got[key];
    return v !== undefined && valid(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function getPairing(): Promise<Pairing | null> {
  return raw<Pairing | null>(
    KEYS.pairing,
    null,
    (v) => v === null || (isObj(v) && typeof v.token === 'string' && typeof v.port === 'number'),
  );
}

export async function setPairing(p: Pairing | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.pairing]: p });
}

export function getHealth(): Promise<Health> {
  return raw<Health>(KEYS.health, DEFAULTS.health, (v) => isObj(v) && typeof v.phase === 'string');
}

export async function setHealth(h: Health): Promise<void> {
  await chrome.storage.local.set({ [KEYS.health]: h });
}

export function getCapture(): Promise<Capture> {
  return raw<Capture>(KEYS.capture, DEFAULTS.capture, (v) => isObj(v) && typeof v.enabled === 'boolean');
}

export async function setCapture(enabled: boolean): Promise<Capture> {
  const next: Capture = { enabled, changedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [KEYS.capture]: next });
  return next;
}

export function getAllowlist(): Promise<Allowlist> {
  return raw<Allowlist>(KEYS.allowlist, DEFAULTS.allowlist, (v) => isObj(v) && Array.isArray(v.rules));
}

export async function setAllowlist(a: Allowlist): Promise<void> {
  await chrome.storage.local.set({ [KEYS.allowlist]: a });
}

export function getActivity(): Promise<ActivityRecord[]> {
  return raw<ActivityRecord[]>(KEYS.activity, [], (v) => Array.isArray(v));
}

export async function setActivity(records: ActivityRecord[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.activity]: records });
}

export function getLogVisits(): Promise<boolean> {
  return raw<boolean>(KEYS.logVisits, true, (v) => typeof v === 'boolean');
}

export async function setLogVisits(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.logVisits]: enabled });
}

export function getRecent(): Promise<RecentClip[]> {
  return raw<RecentClip[]>(KEYS.recent, [], (v) => Array.isArray(v));
}

export async function setRecent(ring: RecentClip[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.recent]: ring });
}

export function getRecorders(): Promise<RecorderState> {
  return raw<RecorderState>(KEYS.recorders, { byId: {} }, (v) => isObj(v) && isObj(v.byId));
}

export async function setRecorders(state: RecorderState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.recorders]: state });
}

export function getRecorderSeen(): Promise<RecorderSeenEntry[]> {
  return raw<RecorderSeenEntry[]>(KEYS.recorderSeen, [], (v) => Array.isArray(v));
}

export async function setRecorderSeen(ring: RecorderSeenEntry[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.recorderSeen]: ring });
}

export function getInvitePending(): Promise<PendingInvite[]> {
  return raw<PendingInvite[]>(KEYS.invitePending, [], (v) => Array.isArray(v));
}

export async function setInvitePending(list: PendingInvite[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.invitePending]: list });
}

export function getNetLog(): Promise<NetLogEntry[]> {
  return raw<NetLogEntry[]>(KEYS.netLog, [], (v) => Array.isArray(v));
}

export async function setNetLog(list: NetLogEntry[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.netLog]: list });
}

export function getAcceptSeen(): Promise<Record<string, number>> {
  return raw<Record<string, number>>(KEYS.acceptSeen, {}, (v) => isObj(v));
}

export async function setAcceptSeen(map: Record<string, number>): Promise<void> {
  await chrome.storage.local.set({ [KEYS.acceptSeen]: map });
}

export function getAgentAdapters(): Promise<AgentAdapterState> {
  return raw<AgentAdapterState>(KEYS.agentAdapters, { byId: {} }, (v) => isObj(v) && isObj(v.byId));
}

export async function setAgentAdapters(state: AgentAdapterState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.agentAdapters]: state });
}

export function getAgentActionAllow(): Promise<AgentActionAllowState> {
  return raw<AgentActionAllowState>(KEYS.agentActionAllow, { byId: {} }, (v) => isObj(v) && isObj(v.byId));
}

export async function setAgentActionAllow(state: AgentActionAllowState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.agentActionAllow]: state });
}

export function getNavigateHostAllow(): Promise<NavigateHostAllowState> {
  return raw<NavigateHostAllowState>(KEYS.navigateHostAllow, { byHost: {} }, (v) => isObj(v) && isObj(v.byHost));
}

export async function setNavigateHostAllow(state: NavigateHostAllowState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.navigateHostAllow]: state });
}

export function getAgentTab(): Promise<AgentTabRef | null> {
  return raw<AgentTabRef | null>(
    KEYS.agentTab,
    null,
    (v) => v === null || (isObj(v) && typeof v.tabId === 'number' && typeof v.adapterId === 'string'),
  );
}

export async function setAgentTab(ref: AgentTabRef | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.agentTab]: ref });
}

// ── brain mode preference ────────────────────────────────────────────────────

export function getBrainModePref(): Promise<BrainModePref | null> {
  return raw<BrainModePref | null>(KEYS.brainMode, null, (v) => v === null || v === 'paired' || v === 'byok');
}

export async function setBrainModePref(pref: BrainModePref | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.brainMode]: pref });
}

// ── BYOK provider settings (LLM reasoning only — never a graph store) ───────

export function getProviderSettings(): Promise<ProviderSettings | null> {
  return raw<ProviderSettings | null>(
    KEYS.provider,
    null,
    (v) =>
      v === null ||
      (isObj(v) && typeof v.provider === 'string' && typeof v.apiKey === 'string' && isObj(v.models)),
  );
}

export async function setProviderSettings(p: ProviderSettings | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.provider]: p });
}

// ── CRM sync settings (nff-admin ingest — see src/crmSync.ts) ───────────────

export function getCrmSync(): Promise<CrmSyncSettings | null> {
  return raw<CrmSyncSettings | null>(
    KEYS.crmSync,
    null,
    (v) => v === null || (isObj(v) && typeof v.enabled === 'boolean' && typeof v.secret === 'string'),
  );
}

export async function setCrmSync(s: CrmSyncSettings | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.crmSync]: s });
}

// ── company brain sync settings (nff-admin ingest — see src/companySync.ts) ─

export function getBrainSync(): Promise<BrainSyncSettings | null> {
  return raw<BrainSyncSettings | null>(
    KEYS.brainSync,
    null,
    (v) => v === null || (isObj(v) && typeof v.enabled === 'boolean' && typeof v.token === 'string'),
  );
}

export async function setBrainSync(s: BrainSyncSettings | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.brainSync]: s });
}

// ── the local brain + clip pipeline (BYOK) ──────────────────────────────────
// Live again — see KEYS' and schema.ts's comments. Writers: brainStore.ts
// (serialized mutations), standaloneDrain.ts (via commitDrain), migrate.ts
// (the legacy sweep, gated on no explicit brain-mode preference).

export function getBrain(): Promise<StandaloneBrain | null> {
  return raw<StandaloneBrain | null>(
    KEYS.brain,
    null,
    (v) => v === null || (isObj(v) && Array.isArray(v.nodes) && Array.isArray(v.edges)),
  );
}

export async function setBrain(brain: StandaloneBrain | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.brain]: brain });
}

export function getClipQueue(): Promise<StandaloneClip[]> {
  return raw<StandaloneClip[]>(KEYS.clipQueue, [], (v) => Array.isArray(v));
}

export async function setClipQueue(queue: StandaloneClip[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.clipQueue]: queue });
}

export function getClipSeen(): Promise<string[]> {
  return raw<string[]>(KEYS.clipSeen, [], (v) => Array.isArray(v));
}

export async function setClipSeen(ids: string[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.clipSeen]: ids });
}

export function getDrainState(): Promise<DrainState> {
  return raw<DrainState>(KEYS.drain, DEFAULT_DRAIN, (v) => isObj(v) && typeof v.nextDrainAtMs === 'number');
}

export async function setDrainState(state: DrainState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.drain]: state });
}

/**
 * The drain's single multi-key commit — one storage.set so a worker kill
 * loses the entire drain result or none of it (clips redeliver, deduped by
 * the seen ring). Callers schedule this on the brainStore chain.
 */
export async function commitDrain(w: {
  brain: StandaloneBrain;
  queue: StandaloneClip[];
  seen: string[];
  activity: ActivityRecord[];
  drain: DrainState;
}): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.brain]: w.brain,
    [KEYS.clipQueue]: w.queue,
    [KEYS.clipSeen]: w.seen,
    [KEYS.activity]: w.activity,
    [KEYS.drain]: w.drain,
  });
}

export async function setMigrationBackup(backup: MigrationBackup | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.migrationBackup]: backup });
}

// ── web-agent action engine (CDP) ────────────────────────────────────────────

export function getActRun(): Promise<ActRunState | null> {
  return raw<ActRunState | null>(
    KEYS.actRun,
    null,
    (v) => v === null || (isObj(v) && typeof v.id === 'string' && typeof v.phase === 'string'),
  );
}

export async function setActRun(run: ActRunState | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.actRun]: run });
}

export function getActHostAllow(): Promise<ActHostAllow> {
  return raw<ActHostAllow>(KEYS.actHostAllow, { byOrigin: {} }, (v) => isObj(v) && isObj(v.byOrigin));
}

export async function setActHostAllow(state: ActHostAllow): Promise<void> {
  await chrome.storage.local.set({ [KEYS.actHostAllow]: state });
}

// ── coding agent ─────────────────────────────────────────────────────────────

export function getCodeProject(): Promise<CodeProjectMeta | null> {
  return raw<CodeProjectMeta | null>(
    KEYS.codeProject,
    null,
    (v) => v === null || (isObj(v) && typeof v.name === 'string'),
  );
}

export async function setCodeProject(meta: CodeProjectMeta | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.codeProject]: meta });
}

// ── local workflow store ─────────────────────────────────────────────────────

export function getWorkflowStore(): Promise<WorkflowStore> {
  return raw<WorkflowStore>(KEYS.workflows, { byId: {} }, (v) => isObj(v) && isObj(v.byId));
}

export async function setWorkflowStore(store: WorkflowStore): Promise<void> {
  await chrome.storage.local.set({ [KEYS.workflows]: store });
}

// ── record-and-automate ──────────────────────────────────────────────────────

export function getTraceActive(): Promise<TraceActiveState | null> {
  return raw<TraceActiveState | null>(
    KEYS.traceActive,
    null,
    (v) => v === null || (isObj(v) && typeof v.recording === 'boolean' && Array.isArray(v.events)),
  );
}

export async function setTraceActive(state: TraceActiveState | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.traceActive]: state });
}

export function getTracePending(): Promise<TracePending | null> {
  return raw<TracePending | null>(
    KEYS.tracePending,
    null,
    (v) => v === null || (isObj(v) && v.v === 1 && Array.isArray(v.events)),
  );
}

export async function setTracePending(rec: TracePending | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.tracePending]: rec });
}

export async function getState(): Promise<StoredState> {
  const [pairing, health, capture, allowlist, activity] = await Promise.all([
    getPairing(),
    getHealth(),
    getCapture(),
    getAllowlist(),
    getActivity(),
  ]);
  return { version: DEFAULTS.version, pairing, health, capture, allowlist, activity };
}

/**
 * Fill in MISSING keys only, never overwrite.
 *
 * onInstalled fires with reason 'update' on EVERY extension update. A naive
 * storage.set(DEFAULTS) there would re-enable capture and wipe the allowlist
 * behind the user's back — a silent regression that no quick manual test
 * catches, which is why the restart check in the README explicitly covers it.
 */
export async function seedDefaults(): Promise<void> {
  const present = await chrome.storage.local.get(Object.values(KEYS));
  const missing: Record<string, unknown> = {};
  if (present[KEYS.version] === undefined) missing[KEYS.version] = DEFAULTS.version;
  if (present[KEYS.health] === undefined) missing[KEYS.health] = DEFAULTS.health;
  if (present[KEYS.capture] === undefined) missing[KEYS.capture] = DEFAULTS.capture;
  if (present[KEYS.allowlist] === undefined) missing[KEYS.allowlist] = DEFAULTS.allowlist;
  if (present[KEYS.activity] === undefined) missing[KEYS.activity] = DEFAULTS.activity;
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
}
