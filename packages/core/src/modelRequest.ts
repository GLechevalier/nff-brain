// The model-request file: how the hooks (which cannot change a Claude Code
// session's model — no hook can) tell the VS Code extension which model the
// session SHOULD be on. The extension watches .nff-brain/model-request.json
// and types `/model <name>` into the Claude terminal. The file is advisory:
// nothing acts on it unless the user enabled nffBrain.autoModel, and stale
// requests (old ts) are ignored, so writing it is always safe.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NoveltyContributor } from './novelty.js';

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

/** Atomic write (temp + rename) so the watcher never sees a half-written file. */
export function writeModelRequest(brainPath: string, req: ModelRequest): void {
  const target = modelRequestPath(brainPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.model-request.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(req, null, 2) + '\n');
  fs.renameSync(tmp, target);
}
