import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// End-to-end over the BUILT CLI (run `npm run build -w nff-brain` first) with a
// mocked `claude` binary. Covers the whole loop: init from CLAUDE.md → distill
// a fake SessionEnd hook payload → recall preamble → hanging-LLM fail-open.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

let ws: string; // fake workspace
let shimDir: string;
let shimBin: string;

function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ws,
    input: opts.stdin,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NFF_BRAIN_CLAUDE_BIN: shimBin,
      NFF_BRAIN_TIMEOUT_MS: '5000',
      NFF_BRAIN_SKIP: '', // make sure the recursion guard isn't inherited
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function brain(): any {
  return JSON.parse(fs.readFileSync(path.join(ws, '.nff-brain', 'brain.json'), 'utf8'));
}

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);

  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-ws-'));
  fs.mkdirSync(path.join(ws, '.git')); // workspace-root marker
  fs.writeFileSync(
    path.join(ws, 'CLAUDE.md'),
    '# my-project\n\n- Run npm run build before committing.\n- Deploy one service at a time.\n- API imports must carry .js extensions.\n',
  );

  // The shim: a platform-appropriate wrapper around claude-shim.mjs.
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-shim-'));
  if (process.platform === 'win32') {
    shimBin = path.join(shimDir, 'claude.cmd');
    fs.writeFileSync(shimBin, `@echo off\r\nnode "${SHIM_JS}" %*\r\n`);
  } else {
    shimBin = path.join(shimDir, 'claude');
    fs.writeFileSync(shimBin, `#!/bin/sh\nexec node "${SHIM_JS}" "$@"\n`);
    fs.chmodSync(shimBin, 0o755);
  }
});

afterAll(async () => {
  // The hang test's killed process tree can hold the temp dirs for a moment on
  // Windows (taskkill is async) — retry rather than fail the suite on cleanup.
  for (const dir of [ws, shimDir]) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

describe('e2e (mocked claude)', () => {
  it('init seeds the hub and ingests CLAUDE.md into nodes + edges', () => {
    const r = runCli(['init']);
    expect(r.status).toBe(0);
    const b = brain();
    const ids = b.nodes.map((n: any) => n.id);
    expect(ids).toContain('build-rules');
    expect(ids).toContain('deploy-procedure');
    expect(ids).toContain('api-conventions');
    expect(b.nodes.find((n: any) => n.category === 'core')).toBeTruthy(); // hub
    // CLAUDE.md-derived nodes are curated seeds.
    expect(b.nodes.find((n: any) => n.id === 'build-rules').origin).toBe('seed');
    // The LLM edge survived, and the orphan got tied to the hub.
    expect(b.edges.some((e: any) => e.from === 'build-rules' && e.to === 'deploy-procedure')).toBe(true);
    const hub = b.nodes.find((n: any) => n.category === 'core');
    expect(b.edges.some((e: any) => e.from === 'api-conventions' && e.to === hub.id)).toBe(true);
  });

  it('distill applies the delta from a SessionEnd hook payload', () => {
    // Fake session transcript (JSONL) — long enough to clear the triviality gate.
    const transcript = path.join(ws, 'transcript.jsonl');
    const filler = 'We investigated the login flow in depth and traced the cookie handling. ';
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: `The login is broken. ${filler}` } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `Found it: the cookie was http-only. ${filler}` }] },
        }),
      ].join('\n'),
    );
    const payload = JSON.stringify({ session_id: 'sess-e2e', transcript_path: transcript, cwd: ws });
    const r = runCli(['distill', '--stdin-hook'], { stdin: payload });
    expect(r.status).toBe(0);
    const b = brain();
    const lesson = b.nodes.find((n: any) => n.id === 'login-cookie-fix');
    expect(lesson).toBeTruthy();
    expect(lesson.origin).toBe('agent');
    expect(lesson.sourceSession).toBe('sess-e2e');
    expect(b.edges.some((e: any) => e.from === 'login-cookie-fix' && e.to === 'build-rules')).toBe(true);
  });

  it('recall prints the preamble and bumps recall counts', () => {
    const r = runCli(['recall', '--query', 'login problems']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('## Your learned skills & playbooks');
    expect(r.stdout).toContain('Login cookie fix');
    expect(r.stdout).toContain('↳ related:');
    const b = brain();
    expect(b.nodes.find((n: any) => n.id === 'login-cookie-fix').recallCount).toBeGreaterThan(0);
  });

  it('recall as a SessionStart hook reads cwd from stdin', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-other-'));
    try {
      const payload = JSON.stringify({ session_id: 's', cwd: ws, hook_event_name: 'SessionStart' });
      const r = runCli(['recall', '--stdin-hook'], { stdin: payload, cwd: other });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('## Your learned skills & playbooks');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('distill fails OPEN (exit 0, graph untouched) when claude hangs', () => {
    const before = JSON.stringify(brain().nodes.map((n: any) => n.id).sort());
    const transcript = path.join(ws, 'transcript.jsonl');
    const payload = JSON.stringify({ session_id: 'sess-hang', transcript_path: transcript, cwd: ws });
    const t0 = Date.now();
    const r = runCli(['distill', '--stdin-hook'], { stdin: payload, env: { SHIM_MODE: 'hang' } });
    expect(r.status).toBe(0); // fail-open: a broken LLM must never break the hook
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(JSON.stringify(brain().nodes.map((n: any) => n.id).sort())).toBe(before);
    // The failure is diagnosable in the log.
    const log = fs.readFileSync(path.join(ws, '.nff-brain', 'last-distill.log'), 'utf8');
    expect(log).toContain('timed out');
  });

  it('doctor reports the brain and exits by health', () => {
    const r = runCli(['doctor']);
    expect(r.stdout).toContain('project brain');
    expect(r.stdout).toContain('node(s)');
  });
});
