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
    expect(r.stdout).toContain('distill model');
    expect(r.stdout).toContain('haiku (default)');
  });

  it('--version prints the package version', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    for (const flag of ['--version', '-v']) {
      const r = runCli([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    }
  });

  it('search ranks seeded nodes and rejects an empty query', () => {
    const r = runCli(['search', 'deploy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deploy-procedure');
    const empty = runCli(['search']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('usage: nff-brain search');
  });
});

// ── ingest-graphify + expand ─────────────────────────────────────────────────

function writeGraphifyFixture(): void {
  const dir = path.join(ws, 'graphify-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'graph.json'),
    JSON.stringify({
      directed: false,
      multigraph: false,
      graph: {},
      nodes: [
        { id: 'a1', label: 'auth_login', file_type: 'code', source_file: 'repo-a/auth/login.py', community: 0 },
        { id: 'a2', label: 'auth_logout', file_type: 'code', source_file: 'repo-a/auth/logout.py', community: 0 },
        { id: 'a3', label: 'session_store', file_type: 'code', source_file: 'repo-a/auth/session.py', community: 0 },
        { id: 'b1', label: 'db_conn', file_type: 'code', source_file: 'repo-b/db/conn.py', community: 1 },
        { id: 'b2', label: 'db_query', file_type: 'code', source_file: 'repo-b/db/query.py', community: 1 },
      ],
      links: [
        { source: 'a1', target: 'a3', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1.0, weight: 1.0 },
        { source: 'a2', target: 'a3', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1.0, weight: 1.0 },
        { source: 'a3', target: 'b1', relation: 'shares_data_with', confidence: 'INFERRED', confidence_score: 0.85, weight: 1.0 },
        { source: 'b1', target: 'b2', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1.0, weight: 1.0 },
      ],
      hyperedges: [
        { id: 'h1', label: 'Login Flow', nodes: ['a1', 'a3'], relation: 'form', confidence: 'EXTRACTED', confidence_score: 1.0, source_file: 'repo-a/auth/login.py' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'GRAPH_REPORT.md'),
    ['### Community 0 - "Auth Layer"', 'Cohesion: 0.42', '', '### Community 1 - "Data Layer"', 'Cohesion: 0.31', ''].join('\n'),
  );
}

describe('e2e ingest-graphify + expand (mocked claude)', () => {
  it('imports intent nodes with graphifyRef, idempotently', () => {
    writeGraphifyFixture();
    const r = runCli(['ingest-graphify', '--no-llm']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('imported 2 area(s)');
    const b = brain();
    const gf = b.nodes.filter((n: any) => n.origin === 'graphify');
    expect(gf.map((n: any) => n.id).sort()).toEqual([
      'gf-area-auth-layer',
      'gf-area-data-layer',
      'gf-flow-login-flow',
      'gf-god-session-store',
    ]);
    const area = gf.find((n: any) => n.id === 'gf-area-auth-layer');
    expect(area.graphifyRef).toMatchObject({ kind: 'community', key: 0, graph: 'graphify-out/graph.json' });
    expect(area.content).toContain('auth_login (repo-a/auth/login.py)');

    // Re-run: wholesale replace, same set, non-graphify nodes untouched.
    const before = b.nodes.filter((n: any) => n.origin !== 'graphify').length;
    const r2 = runCli(['ingest-graphify', '--no-llm']);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('replaced 4 previous graphify node(s)');
    const b2 = brain();
    expect(b2.nodes.filter((n: any) => n.origin === 'graphify')).toHaveLength(4);
    expect(b2.nodes.filter((n: any) => n.origin !== 'graphify')).toHaveLength(before);
  });

  it('respects --max-per-repo', () => {
    const r = runCli(['ingest-graphify', '--no-llm', '--max-per-repo', '1']);
    expect(r.status).toBe(0);
    const gf = brain().nodes.filter((n: any) => n.origin === 'graphify');
    expect(gf).toHaveLength(2); // one per repo
    expect(gf.every((n: any) => n.id.startsWith('gf-area-'))).toBe(true);
  });

  it('writes LLM intent via the batched explainer call', () => {
    const r = runCli(['ingest-graphify']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LLM intent');
    const area = brain().nodes.find((n: any) => n.id === 'gf-area-auth-layer');
    expect(area.content.startsWith('Owns user authentication end to end')).toBe(true);
    expect(area.content).toContain('↳ graphify community 0'); // mechanical pointer kept
  });

  it('fails OPEN to mechanical summaries when claude hangs', () => {
    const t0 = Date.now();
    const r = runCli(['ingest-graphify'], { env: { SHIM_MODE: 'hang' } });
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.stdout).toContain('mechanical summaries');
    expect(brain().nodes.filter((n: any) => n.origin === 'graphify')).toHaveLength(4);
  });

  it('expand lists the underlying code entities from graph.json', () => {
    const r = runCli(['expand', 'gf-flow-login-flow']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('auth_login — repo-a/auth/login.py (code)');
    expect(r.stdout).toContain('session_store — repo-a/auth/session.py (code)');
    expect(r.stdout).toContain('auth_login -calls-> session_store');
  });

  it('recall surfaces codebase-map nodes with the expand hint', () => {
    const r = runCli(['recall', '--query', 'authentication login sessions']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(expand: nff-brain expand gf-area-auth-layer)');
    expect(r.stdout).toContain('codebase-map nodes imported from graphify');
  });

  it('expand fails cleanly when graph.json is gone', () => {
    fs.renameSync(path.join(ws, 'graphify-out', 'graph.json'), path.join(ws, 'graphify-out', 'graph.json.bak'));
    try {
      const r = runCli(['expand', 'gf-flow-login-flow']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('re-run /graphify');
    } finally {
      fs.renameSync(path.join(ws, 'graphify-out', 'graph.json.bak'), path.join(ws, 'graphify-out', 'graph.json'));
    }
  });

  it('ingest-graphify fails cleanly without a graph', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-nogfx-'));
    try {
      fs.mkdirSync(path.join(other, '.git'));
      const r = runCli(['ingest-graphify'], { cwd: other });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('run /graphify first');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
