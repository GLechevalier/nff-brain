import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeClaudeShim } from './fixtures/history.js';

// `nff-brain onboard`, run over the BUILT cli as a real subprocess — never
// in-process, because the wizard ends by calling cmdDoctor(), which calls
// process.exit() when something is unhealthy. A subprocess absorbs that; an
// in-process call would kill the whole test worker.
//
// Only the non-interactive gate is worth covering here: spawnSync's default
// pipes give the child a non-TTY stdin/stdout/stderr, so this is also the
// same path a CI runner hits — it must skip straight to doctor and return,
// never block waiting on a prompt.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

let ws: string;
let fakeHome: string;
let shimDir: string;
let shimBin: string;

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws,
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      NFF_BRAIN_CLAUDE_BIN: shimBin,
      NFF_BRAIN_TIMEOUT_MS: '5000',
      NFF_BRAIN_SKIP: '',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-onboard-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-onboard-ws-'));
  fs.mkdirSync(path.join(ws, '.git'));
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-onboard-shim-'));
  shimBin = makeClaudeShim(shimDir, SHIM_JS);
});

afterAll(() => {
  for (const dir of [ws, shimDir, fakeHome]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('onboard (e2e over the built CLI)', () => {
  it('non-interactive (piped) skips straight to the doctor check without prompting', () => {
    const r = runCli(['onboard']);
    expect(r.stdout).toContain('skipping the guided setup');
    expect(r.stdout).toContain('distill model'); // a doctor line — proves it actually ran
  });

  it('any flag also forces the non-interactive path', () => {
    const r = runCli(['onboard', '--yes']);
    expect(r.stdout).toContain('skipping the guided setup');
  });
});
