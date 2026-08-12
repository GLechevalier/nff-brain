// The recorder's pure half: wire validation, clip formatting, and the
// persistent dedupe ring's logic. No chrome.* — fully unit-testable.

import { RECORDER_SEEN_MAX, RECORDER_SEEN_TTL_MS } from './recorderTypes.js';
import type { RecorderEventMsg, RecorderSeenEntry } from './recorderTypes.js';

const STR_MAX = 300;
const MAX_FIELDS = 8;

/**
 * NEVER TRUST THE WIRE — a content script runs in a hostile page's world-model
 * (an isolated world, but the DOM it reads is the page's). Clamp everything.
 */
export function validateRecorderEvent(msg: unknown): RecorderEventMsg | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'recorderEvent') return null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, STR_MAX) : null;
  const adapter = str(m.adapter);
  const action = str(m.action);
  const key = str(m.key);
  const title = str(m.title);
  const at = typeof m.at === 'string' && Number.isFinite(Date.parse(m.at)) ? m.at : new Date().toISOString();
  if (!adapter || !action || !key || !title) return null;

  const fields: Record<string, string> = {};
  if (typeof m.fields === 'object' && m.fields !== null) {
    for (const [k, v] of Object.entries(m.fields as Record<string, unknown>).slice(0, MAX_FIELDS)) {
      const key2 = k.trim().slice(0, 40);
      const val = str(v);
      if (key2 && val) fields[key2] = val;
    }
  }
  return { type: 'recorderEvent', adapter, action, key, at, title, fields };
}

/**
 * Map an event onto the existing clip queue as kind 'note' with a stable,
 * machine-recognizable first line. Deliberately NOT a fifth ClipKind: the
 * drain distills text anyway, and the `recorder-event <action>` prefix is the
 * forward-compatibility hook if a structured kind ever earns its keep.
 */
export function formatRecorderClip(msg: RecorderEventMsg): { text: string; title: string } {
  const lines = [
    `recorder-event ${msg.action}`,
    `title: ${msg.title}`,
    ...Object.entries(msg.fields).map(([k, v]) => `${k}: ${v}`),
    `at: ${msg.at}`,
  ];
  return { text: lines.join('\n'), title: msg.title };
}

// ── persistent dedupe ring (worker-side; storage-backed, never a module var) ─

export function recorderSeenRecently(ring: readonly RecorderSeenEntry[], key: string, nowMs: number): boolean {
  return ring.some((r) => r.key === key && nowMs - r.atMs < RECORDER_SEEN_TTL_MS);
}

export function pushRecorderSeen(
  ring: readonly RecorderSeenEntry[],
  key: string,
  nowMs: number,
): RecorderSeenEntry[] {
  const live = ring.filter((r) => nowMs - r.atMs < RECORDER_SEEN_TTL_MS && r.key !== key);
  return [{ key, atMs: nowMs }, ...live].slice(0, RECORDER_SEEN_MAX);
}
