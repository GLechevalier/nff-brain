import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeDir } from './paths.js';

// NODE-ONLY. Locates (and installs) the optional embedding runtime.
//
// WHY A "RUNTIME HOME" AND NOT A PACKAGE DEPENDENCY:
//   • A plain dependency, or an optionalDependency (npm installs those by
//     DEFAULT), would take `npm i -g nff-brain` from a ~200 KB single-file
//     install to ~400 MB with a native postinstall — for a feature most users
//     never turn on. The zero-dep tarball is the CLI's headline property.
//   • peerDependenciesMeta.optional does not work either: a globally installed
//     CLI cannot resolve a sibling global package. Node probes
//     <ancestor>/node_modules for each ancestor dir, and the global
//     node_modules dir is itself never probed as one. It resolves fine inside
//     this monorepo and silently fails for every real user — the worst kind of
//     bug to ship.
// So the model runtime is installed on demand into ~/.nff-brain/runtime and
// resolved at runtime. Absent ⇒ every embed function returns null ⇒ callers
// fall back to lexical search. Same fail-soft shape as the sibling worker's
// nff-agent-worker/src/roles/agent/brain/embed.ts.
//
// This module spawns `npm`, which makes it the second subprocess module after
// claude.ts. That convention is about the LLM path (one `claude -p` per
// command); doctor.ts already spawns `claude --version` directly. Install is an
// explicit, user-invoked, one-time operation — not a hot path.

export const PACKAGE = '@huggingface/transformers';
export const PACKAGE_SPEC = `${PACKAGE}@^3`;

export interface RuntimeStatus {
  installed: boolean;
  /** Absolute path to the ESM entry point, when resolvable. */
  entry: string | null;
  version: string | null;
  dir: string;
  /** Why resolution failed, for doctor. Never thrown. */
  detail: string | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Condition priority for picking an entry out of an `exports` map. ORDER IS
// LOAD-BEARING: "node" must beat "import", or transformers.js hands back its
// BROWSER build, which treats env.cacheDir as a URL base and fails with
// "Failed to parse URL from /models/...". "require" is deliberately absent — we
// load through import().
const CONDITIONS = ['node', 'import', 'default'];

/**
 * Resolve a conditional exports value to a relative path. Conditions nest
 * arbitrarily ({ node: { import: { types, default } } }), so this recurses
 * rather than peeking one level down.
 */
function pickCondition(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const c of CONDITIONS) {
    if (c in o) {
      const r = pickCondition(o[c]);
      if (r) return r;
    }
  }
  return null;
}

/** Pick the Node ESM entry from a package.json's exports/module/main. */
function esmEntry(pkgDir: string, pkg: Record<string, unknown>): string {
  const exp = pkg.exports;
  // A bare exports object with no "." key IS the root condition set.
  const root = exp && typeof exp === 'object' ? ((exp as Record<string, unknown>)['.'] ?? exp) : exp;
  const rel =
    pickCondition(root) ??
    (typeof pkg.module === 'string' ? pkg.module : null) ??
    (typeof pkg.main === 'string' ? pkg.main : null) ??
    'index.js';
  return path.resolve(pkgDir, rel);
}

/** Turn a package directory into a resolved status, or null if unusable. */
function fromPackageDir(pkgDir: string, dir: string): RuntimeStatus | null {
  const manifest = path.join(pkgDir, 'package.json');
  const pkg = readJson(manifest);
  if (!pkg) return null;
  const entry = esmEntry(pkgDir, pkg);
  if (!fs.existsSync(entry)) return null;
  return {
    installed: true,
    entry,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    dir,
    detail: null,
  };
}

/**
 * Resolve the embedding package. Never throws.
 *
 * Order: explicit override → the runtime home → node_modules near cwd (monorepo
 * / dev installs, and how the opt-in integration test finds a devDependency).
 *
 * NOTE: we probe the filesystem rather than require.resolve'ing
 * `<pkg>/package.json`. Modern packages ship an `exports` map, and unless it
 * explicitly lists "./package.json" Node REFUSES that subpath with a
 * "Cannot find module" that looks exactly like "not installed" —
 * @huggingface/transformers is one of them. Resolving the manifest by hand also
 * lets us pick the ESM entry deliberately instead of getting whatever the
 * `require` condition points at.
 */
export function resolveTransformers(): RuntimeStatus {
  const dir = runtimeDir();
  const override = process.env.NFF_BRAIN_TRANSFORMERS;
  if (override) {
    // Accept either the package directory or the entry file itself.
    const asDir = fs.existsSync(path.join(override, 'package.json')) ? fromPackageDir(override, dir) : null;
    if (asDir) return { ...asDir, detail: 'NFF_BRAIN_TRANSFORMERS' };
    if (fs.existsSync(override)) {
      return { installed: true, entry: override, version: null, dir, detail: 'NFF_BRAIN_TRANSFORMERS' };
    }
    return {
      installed: false,
      entry: null,
      version: null,
      dir,
      detail: `NFF_BRAIN_TRANSFORMERS points at a missing path: ${override}`,
    };
  }

  const segments = PACKAGE.split('/');
  const direct = fromPackageDir(path.join(dir, 'node_modules', ...segments), dir);
  if (direct) return direct;

  // Dev/monorepo fallback. createRequire, NOT import.meta.resolve — the latter
  // is Node 20+ and CI covers Node 18.
  let lastDetail: string | null = `not found under ${path.join(dir, 'node_modules')}`;
  try {
    const req = createRequire(pathToFileURL(path.join(process.cwd(), 'index.js')));
    // Resolve the ENTRY (allowed by every exports map), then walk up to the
    // package root by looking for the manifest.
    let cur = path.dirname(req.resolve(PACKAGE));
    for (let i = 0; i < 6; i++) {
      const found = fromPackageDir(cur, dir);
      if (found) return found;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch (err) {
    lastDetail = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  }
  return { installed: false, entry: null, version: null, dir, detail: lastDetail };
}

export interface RuntimeInstallResult {
  ok: boolean;
  /** The exact command run, so a failure is self-diagnosing (Windows paths). */
  command: string;
  output: string;
}

/**
 * npm-install the embedding runtime into its own home. Returns rather than
 * throws — callers print the command and the output on failure.
 */
export function installRuntime(opts: { spec?: string; timeoutMs?: number } = {}): RuntimeInstallResult {
  const dir = runtimeDir();
  const spec = opts.spec ?? PACKAGE_SPEC;
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      JSON.stringify({ name: 'nff-brain-runtime', private: true, version: '0.0.0' }, null, 2) + '\n',
    );
  }
  const args = ['install', '--prefix', dir, spec, '--omit=dev', '--no-audit', '--no-fund'];
  // Quote for display only; spawn passes argv directly, so spaces are safe.
  const command = `npm ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  const r = spawnSync('npm', args, {
    shell: process.platform === 'win32',
    windowsHide: true,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 15 * 60_000,
    cwd: dir,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, command, output };
}

/** Remove the runtime home. Weights in the model cache are left alone. */
export function uninstallRuntime(): boolean {
  const dir = runtimeDir();
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
