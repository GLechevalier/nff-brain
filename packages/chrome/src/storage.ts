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

import { DEFAULTS, KEYS } from './schema.js';
import type { ActivityRecord, Allowlist, Capture, Health, Pairing, StoredState } from './schema.js';

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
