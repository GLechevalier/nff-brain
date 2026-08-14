// Plain Chrome spawner for the act benchmark — deliberately NOT Playwright.
// A Playwright/CDP client auto-attaches DevTools sessions to page targets,
// which EVICTS the extension's chrome.debugger attach ("Debugger is not
// attached to the tab") — the very engine this benchmark measures. So the
// browser is a bare child process; ALL orchestration goes through the bench
// driver inside the extension (see harness/fixtures.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BENCH_SENTINEL } from '@nff-brain/core/benchProtocol';

export interface ChromeHandle {
  child: ChildProcess;
  profileDir: string;
  kill(): void;
}

export function chromeDistDir(evalsRoot: string): string {
  return path.resolve(evalsRoot, '..', 'chrome', 'dist');
}

/** Throws unless dist/ is a BENCH build (sentinel) with the TEST manifest. */
export function assertBenchDist(distDir: string): void {
  const sw = path.join(distDir, 'sw.js');
  if (!fs.existsSync(sw) || !fs.readFileSync(sw, 'utf8').includes(BENCH_SENTINEL)) {
    throw new Error(
      `${sw} is not a bench build — rebuild with:\n` +
        `  PowerShell: $env:NFF_BRAIN_BENCH='1'; $env:NFF_BRAIN_TEST_MANIFEST='1'; npm run build -w nff-brain-chrome`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
  };
  if (manifest.host_permissions === undefined) {
    throw new Error('dist/manifest.json is the production variant — rebuild with NFF_BRAIN_TEST_MANIFEST=1 as well');
  }
}

export function findChrome(): string {
  if (process.env.NFF_EVALS_CHROME) return process.env.NFF_EVALS_CHROME;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['PROGRAMFILES'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('could not find chrome — set NFF_EVALS_CHROME to the executable path');
}

export interface LaunchOptions {
  evalsRoot: string;
  /** Profile name under .profiles/ — persists across runs (grants, pairing). */
  profile: string;
  startUrl: string;
  /** Wipe the profile before launching (engine layer default: keep it). */
  freshProfile?: boolean;
}

/**
 * Resolve the bench dist to load, STAGED under state/bench-dist. dist/ is
 * shared with the normal dev loop (and with concurrent sessions), so loading
 * it directly means any production rebuild clobbers a benchmark mid-flight.
 * When dist/ currently IS a bench build, refresh the stage from it; when it
 * is not, fall back to the last staged copy (with a note) so the benchmark
 * keeps working across the other workflow's rebuilds.
 */
export function stageBenchDist(evalsRoot: string): string {
  const distDir = chromeDistDir(evalsRoot);
  const stageDir = path.join(evalsRoot, 'state', 'bench-dist');
  let distIsBench = false;
  try {
    assertBenchDist(distDir);
    distIsBench = true;
  } catch (err) {
    if (!fs.existsSync(path.join(stageDir, 'sw.js'))) throw err;
  }
  if (distIsBench) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.cpSync(distDir, stageDir, { recursive: true });
  } else {
    console.log('note: chrome/dist is currently a production build — using the previously staged bench dist');
  }
  assertBenchDist(stageDir);
  return stageDir;
}

export function launchChrome(opts: LaunchOptions): ChromeHandle {
  const distDir = stageBenchDist(opts.evalsRoot);
  const profileDir = path.join(opts.evalsRoot, '.profiles', opts.profile);
  if (opts.freshProfile) fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(
    findChrome(),
    [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${distDir}`,
      `--disable-extensions-except=${distDir}`,
      '--silent-debugger-extension-api',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      opts.startUrl,
    ],
    { stdio: 'ignore' },
  );

  return {
    child,
    profileDir,
    kill() {
      try {
        if (process.platform === 'win32' && child.pid) {
          execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* already gone */
      }
    },
  };
}
