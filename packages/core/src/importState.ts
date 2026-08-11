// The import ledger: `.nff-brain/import-state.json`.
//
// Re-running `nff-brain import` must be cheap and must not nag. Two independent
// guards do that, and BOTH are needed:
//
//   SESSION GUARD — a session already mined is skipped outright. Unless its
//   byte count changed, which means it was resumed and grew, so there is new
//   material in it.
//
//   PROPOSAL GUARD — a hash of every accepted item. Even a genuinely new
//   session re-proposes the same house rules, and this drops them before the
//   preview. Crucially it keys on kind+title, NOT on the node, so it still
//   holds after the user DELETES an imported node — which is exactly the case
//   where re-offering it would be most annoying: deleting it meant "no".

import * as fs from 'node:fs';
import { brainLogPath } from './paths.js';

export const IMPORT_STATE_FILE = 'import-state.json';
/** Plenty for years of imports; oldest fall off first. */
export const MAX_PROPOSAL_HASHES = 2000;

export interface ImportedSession {
  at: string; // ISO, when it was mined
  bytes: number; // size when mined — a change means the session was resumed
  mtimeMs: number;
  produced: string[]; // node ids this session contributed to
}

export interface ImportState {
  version: 1;
  lastRunAt: string | null;
  sessions: Record<string, ImportedSession>;
  dirCwd: Record<string, string | null>; // encoded project dir → real cwd
  proposalHashes: string[];
}

export function emptyImportState(): ImportState {
  return { version: 1, lastRunAt: null, sessions: {}, dirCwd: {}, proposalHashes: [] };
}

export function importStatePath(brainPath: string): string {
  return brainLogPath(brainPath, IMPORT_STATE_FILE);
}

/** Load the ledger. A missing or corrupt file is simply an empty ledger. */
export function loadImportState(brainPath: string): ImportState {
  let raw: string;
  try {
    raw = fs.readFileSync(importStatePath(brainPath), 'utf8');
  } catch {
    return emptyImportState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImportState>;
    return {
      version: 1,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      dirCwd: parsed.dirCwd && typeof parsed.dirCwd === 'object' ? parsed.dirCwd : {},
      proposalHashes: Array.isArray(parsed.proposalHashes)
        ? parsed.proposalHashes.filter((h): h is string => typeof h === 'string')
        : [],
    };
  } catch {
    // Losing the ledger costs one duplicated preview, never a node — so a
    // damaged file is reset rather than made fatal.
    return emptyImportState();
  }
}

export function saveImportState(brainPath: string, state: ImportState): void {
  const file = importStatePath(brainPath);
  try {
    fs.mkdirSync(brainLogPath(brainPath, '.'), { recursive: true });
  } catch {
    /* already there */
  }
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Sessions to skip: mined already AND unchanged in size since. */
export function alreadyImported(state: ImportState): Set<string> {
  return new Set(Object.keys(state.sessions));
}

/** True when a session was mined before and has not grown since. */
export function isUnchanged(state: ImportState, sessionId: string, bytes: number): boolean {
  const prev = state.sessions[sessionId];
  return !!prev && prev.bytes === bytes;
}

/**
 * Session ids to skip on this run: previously mined and the same size. A
 * resumed session that grew is deliberately NOT skipped.
 */
export function skippableSessionIds(state: ImportState, sizeBySessionId?: Map<string, number>): Set<string> {
  const out = new Set<string>();
  for (const [id, rec] of Object.entries(state.sessions)) {
    const now = sizeBySessionId?.get(id);
    if (now === undefined || now === rec.bytes) out.add(id);
  }
  return out;
}

export function seenProposalHashes(state: ImportState): Set<string> {
  return new Set(state.proposalHashes);
}

/** Record accepted proposals, oldest hashes falling off the front. */
export function recordProposalHashes(state: ImportState, hashes: readonly string[]): void {
  const seen = new Set(state.proposalHashes);
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    state.proposalHashes.push(h);
  }
  if (state.proposalHashes.length > MAX_PROPOSAL_HASHES) {
    state.proposalHashes = state.proposalHashes.slice(state.proposalHashes.length - MAX_PROPOSAL_HASHES);
  }
}

export function recordSession(
  state: ImportState,
  sessionId: string,
  info: { bytes: number; mtimeMs: number; produced?: string[]; now?: Date },
): void {
  state.sessions[sessionId] = {
    at: (info.now ?? new Date()).toISOString(),
    bytes: info.bytes,
    mtimeMs: info.mtimeMs,
    produced: info.produced ?? [],
  };
}
