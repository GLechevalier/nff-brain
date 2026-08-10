import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BRAIN_DIR = '.nff-brain';
export const BRAIN_FILE = 'brain.json';

// Walk up from cwd to find the workspace root: the first directory containing
// .nff-brain/, .claude/, or .git/. Falls back to cwd itself.
export function findWorkspaceRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const marker of [BRAIN_DIR, '.claude', '.git']) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export function projectBrainPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, BRAIN_DIR, BRAIN_FILE);
}

export function globalBrainPath(): string {
  return path.join(os.homedir(), BRAIN_DIR, BRAIN_FILE);
}

export interface BrainPaths {
  workspaceRoot: string;
  project: string; // may not exist yet
  global: string; // may not exist yet
}

export function resolveBrainPaths(cwd = process.cwd()): BrainPaths {
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    workspaceRoot,
    project: projectBrainPath(workspaceRoot),
    global: globalBrainPath(),
  };
}

// Log file used by the fail-open hook commands (recall/distill must never
// break a Claude session, so errors go here instead of stderr/exit codes).
export function brainLogPath(brainPath: string, name: string): string {
  return path.join(path.dirname(brainPath), name);
}
