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

/** Pick the ESM entry from a package.json's exports/module/main, in that order. */
function esmEntry(pkgDir: string, pkg: Record<string, unknown>): string {
  const exp = pkg.exports as unknown;
  const fromExports = (() => {
    if (!exp || typeof exp !== 'object') return null;
    const root = (exp as Record<string, unknown>)['.'] ?? exp;
    if (typeof root === 'string') return root;
    if (!root || typeof root !== 'object') return null;
    const r = root as Record<string, unknown>;
    for (const key of ['import', 'node', 'default']) {
      const v = r[key];
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        const nested = (v as Record<string, unknown>)['default'] ?? (v as Record<string, unknown>)['import'];
        if (typeof nested === 'string') return nested;
      }
    }
    return null;
  })();
  const rel =
    fromExports ??
    (typeof pkg.module === 'string' ? pkg.module : null) ??
    (typeof pkg.main === 'string' ? pkg.main : null) ??
    'index.js';
  return path.resolve(pkgDir, rel);
}

/**
 * Resolve the embedding package, or null. Never throws.
 *
 * Order: explicit override → the runtime home → a bare specifier (monorepo /
 * dev installs, and how the opt-in integration test finds a devDependency).
 */
export function resolveTransformers(): RuntimeStatus {
  const dir = runtimeDir();
  const override = process.env.NFF_BRAIN_TRANSFORMERS;
  if (override) {
    if (fs.existsSync(override)) {
      return { installed: true, entry: override, version: null, dir, detail: 'NFF_BRAIN_TRANSFORMERS' };
    }
    return { installed: false, entry: null, version: null, dir, detail: `NFF_BRAIN_TRANSFORMERS points at a missing path: ${override}` };
  }

  // createRequire, NOT import.meta.resolve — the latter is Node 20+ and CI
  // covers Node 18.
  const bases = [path.join(dir, 'index.js'), path.join(process.cwd(), 'index.js')];
  let lastDetail: string | null = null;
  for (const base of bases) {
    try {
      const req = createRequire(pathToFileURL(base));
      const manifest = req.resolve(`${PACKAGE}/package.json`);
      const pkgDir = path.dirname(manifest);
      const pkg = readJson(manifest);
      if (!pkg) {
        lastDetail = `unreadable ${manifest}`;
        continue;
      }
      const entry = esmEntry(pkgDir, pkg);
      if (!fs.existsSync(entry)) {
        lastDetail = `entry missing: ${entry}`;
        continue;
      }
      return {
        installed: true,
        entry,
        version: typeof pkg.version === 'string' ? pkg.version : null,
        dir,
        detail: null,
      };
    } catch (err) {
      lastDetail = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    }
  }
  return { installed: false, entry: null, version: null, dir, detail: lastDetail };
}

export interface InstallResult {
  ok: boolean;
  /** The exact command run, so a failure is self-diagnosing (Windows paths). */
  command: string;
  output: string;
}

/**
 * npm-install the embedding runtime into its own home. Returns rather than
 * throws — callers print the command and the output on failure.
 */
export function installRuntime(opts: { spec?: string; timeoutMs?: number } = {}): InstallResult {
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
