// The model-request file: how the hooks (which cannot change a Claude Code
// session's model — no hook can) tell the VS Code extension which model the
// session SHOULD be on. The extension watches .nff-brain/model-request.json
// and types `/model <name>` into the Claude terminal. The file is advisory:
// nothing acts on it unless the user enabled nffBrain.autoModel, and stale
// requests (old ts) are ignored, so writing it is always safe.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NoveltyContributor } from './novelty.js';
import { writeFileAtomic } from './store.js';

export const MODEL_REQUEST_FILE = 'model-request.json';

export interface ModelRequest {
  version: 1;
  sessionId?: string;
  cwd: string; // workspace root the request belongs to (multi-window safety)
  model: string;
  novelty: number;
  ts: string; // ISO — consumers ignore requests older than ~20s
  source: 'session-start' | 'prompt';
  top: NoveltyContributor[];
}

/** Beside the brain file, like the fail-open logs. */
export function modelRequestPath(brainPath: string): string {
  return path.join(path.dirname(brainPath), MODEL_REQUEST_FILE);
}

export function readModelRequest(brainPath: string): ModelRequest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelRequestPath(brainPath), 'utf8')) as ModelRequest;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.model === 'string' ? parsed : null;
  } catch {
    return null; // absent or malformed — same as no request
  }
}

/**
 * Atomic write so the watcher never sees a half-written file. Shares store.ts's
 * Windows EPERM/EBUSY rename retry; its temp files are dotfiles in the same
 * directory, which the extension's `model-request.json` watcher ignores.
 */
export function writeModelRequest(brainPath: string, req: ModelRequest): void {
  writeFileAtomic(modelRequestPath(brainPath), JSON.stringify(req, null, 2) + '\n');
}
