import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BRAIN_DIR = '.nff-brain';
export const BRAIN_FILE = 'brain.json';
export const VECTORS_FILE = 'vectors.json';

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

// ── semantic search (optional tier) ──────────────────────────────────────────
// Vectors live in a SIDECAR beside each brain file, never inside brain.json:
// that file is pretty-printed, hand-editable and round-trips through the
// nffbrain: markdown editor, and every loadBrain on the hook path would pay to
// parse ~400×384 floats for nothing. The sidecar is derived data — losing it
// costs one `nff-brain index`, never a node.

export function vectorsPath(brainPath: string): string {
  return brainLogPath(brainPath, VECTORS_FILE);
}

/**
 * Where the opt-in embedding runtime is installed. It is deliberately NOT a
 * dependency of the published CLI (whose whole point is a zero-dep, single-file
 * tarball) nor of the VSIX (packaged --no-dependencies). `nff-brain semantic
 * install` npm-installs into here; everything resolves it at runtime and falls
 * back to lexical search when it is absent.
 */
export function runtimeDir(): string {
  return process.env.NFF_BRAIN_RUNTIME_DIR ?? path.join(os.homedir(), BRAIN_DIR, 'runtime');
}

/** Model weight cache (mirrors the worker's BRAIN_EMBED_CACHE_DIR). */
export function embedCacheDir(): string {
  return process.env.NFF_BRAIN_EMBED_CACHE_DIR ?? path.join(os.homedir(), BRAIN_DIR, 'models');
}
