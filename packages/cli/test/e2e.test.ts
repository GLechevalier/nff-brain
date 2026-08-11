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
// Recall merges the GLOBAL brain into every result, so without an isolated home
// these tests read whatever is in the developer's own ~/.nff-brain/brain.json
// and node counts drift with it. Point the spawned CLI at a scratch home.
let fakeHome: string;

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
      HOME: fakeHome, // os.homedir(): POSIX
      USERPROFILE: fakeHome, // os.homedir(): Windows
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function brain(): any {
  return JSON.parse(fs.readFileSync(path.join(ws, '.nff-brain', 'brain.json'), 'utf8'));
}

/** Last event appended to the workspace's activity stream (the glow feed). */
function lastActivity(wsDir = ws): any {
  const raw = fs.readFileSync(path.join(wsDir, '.nff-brain', 'activity.jsonl'), 'utf8').trim();
  const lines = raw.split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);

  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-home-'));
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
  for (const dir of [ws, shimDir, fakeHome]) {
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
    // The glow feed saw the write.
    const act = lastActivity();
    expect(act.kind).toBe('distill');
    expect(act.ids).toContain('login-cookie-fix');
    expect(act.sessionId).toBe('sess-e2e');
  });

  it('recall prints the preamble and bumps recall counts', () => {
    const r = runCli(['recall', '--query', 'login problems']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('## Your learned skills & playbooks');
    expect(r.stdout).toContain('Login cookie fix');
    expect(r.stdout).toContain('↳ related:');
    const b = brain();
    expect(b.nodes.find((n: any) => n.id === 'login-cookie-fix').recallCount).toBeGreaterThan(0);
    const act = lastActivity();
    expect(act.kind).toBe('recall');
    expect(act.ids).toContain('login-cookie-fix');
    expect(act.seedCount).toBe(act.ids.length); // small brain → whole-graph bypass
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
    const act = lastActivity();
    expect(act.kind).toBe('search');
    expect(act.ids).toContain('deploy-procedure');
    const empty = runCli(['search']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('usage: nff-brain search');
  });
});

// ── semantic search (optional tier, NEVER installed in CI) ───────────────────
//
// CI runs {ubuntu, windows} × node {18,20,22} and must never download a ~400 MB
// native runtime or a model. So these tests all assert the OFF path: search
// keeps working, nothing errors, and nothing exits non-zero. NFF_BRAIN_RUNTIME_DIR
// is pointed at an empty dir so a developer who HAS installed the runtime
// locally still exercises the same "not installed" branch.

describe('e2e semantic search (runtime absent)', () => {
  let emptyRuntime: string;
  const off = () => ({ env: { NFF_BRAIN_RUNTIME_DIR: emptyRuntime, NFF_BRAIN_TRANSFORMERS: '' } });

  beforeAll(() => {
    emptyRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-rt-'));
  });

  afterAll(() => {
    fs.rmSync(emptyRuntime, { recursive: true, force: true });
  });

  it('search output is unchanged when semantic is unavailable', () => {
    const r = runCli(['search', 'deploy'], off());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deploy-procedure');
    // The pure-lexical format: "0.62  id  [category] title" — no lex/sem columns.
    expect(r.stdout).not.toContain('lex   sem');
    expect(r.stdout.split('\n')[0]).toMatch(/^\d\.\d{2}\s{2}\S+/);
  });

  it('--lexical forces the lexical path and matches the default output', () => {
    const auto = runCli(['search', 'deploy'], off());
    const lex = runCli(['search', 'deploy', '--lexical'], off());
    expect(lex.status).toBe(0);
    expect(lex.stdout).toBe(auto.stdout);
  });

  it('--semantic explains itself instead of failing', () => {
    const r = runCli(['search', 'deploy', '--semantic'], off());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('deploy-procedure'); // still ranked
    expect(r.stdout).toContain('semantic install');
  });

  it('index exits 0 and writes no sidecar when the runtime is absent', () => {
    const r = runCli(['index'], off());
    expect(r.status).toBe(0); // scripts and the distill tail depend on this
    expect(r.stdout).toContain('semantic search is not enabled');
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'vectors.json'))).toBe(false);
  });

  it('index --check reports staleness without needing the runtime', () => {
    const r = runCli(['index', '--check'], off());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/project: \d+ current, \d+ stale/);
  });

  it('semantic status reports "not installed" and exits 0', () => {
    const r = runCli(['semantic', 'status'], off());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not installed');
    expect(r.stdout).toContain('nff-brain semantic install');
  });

  it('semantic rejects an unknown subcommand', () => {
    const r = runCli(['semantic', 'frobnicate'], off());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown subcommand');
  });

  it('doctor reports semantic as off without flipping its exit code', () => {
    const r = runCli(['doctor'], off());
    expect(r.stdout).toContain('semantic search');
    expect(r.stdout).toContain('off (lexical only)');
    // The `·` marker, not `✗` — optional by construction.
    expect(r.stdout).toMatch(/· semantic search/);
  });
});

// ── build artifacts ──────────────────────────────────────────────────────────

describe('built artifacts stay free of the optional runtime', () => {
  // embed.ts hides its dynamic import behind new Function, and both bundlers
  // mark the package external. If either regresses, esbuild rewrites the
  // import into a require() shim in the CJS extension bundle — which cannot
  // load an ESM-only package, and fails only at runtime in a user's VS Code.
  const PKG = '@huggingface/transformers';
  const artifacts = [
    path.resolve(here, '..', 'dist', 'index.js'),
    path.resolve(here, '..', '..', 'vscode', 'dist', 'extension.js'),
    path.resolve(here, '..', '..', 'vscode', 'dist', 'webview.js'),
  ];

  it.each(artifacts)('%s does not statically link the runtime', (file) => {
    if (!fs.existsSync(file)) return; // vscode bundles need `npm run build`
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toContain(`require("${PKG}")`);
    expect(src).not.toContain(`require('${PKG}')`);
    expect(src).not.toContain(`from"${PKG}"`);
    expect(src).not.toContain(`from "${PKG}"`);
  });

  it('the webview bundle contains no embedding code at all', () => {
    const file = path.resolve(here, '..', '..', 'vscode', 'dist', 'webview.js');
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toContain(PKG);
    expect(src).not.toContain('onnxruntime');
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
    const act = lastActivity();
    expect(act.kind).toBe('expand');
    expect(act.ids).toEqual(['gf-flow-login-flow']);
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

// ── novelty → auto-model request loop ────────────────────────────────────────

describe('e2e novelty / model-request', () => {
  let nws: string; // dedicated workspace with a hand-crafted brain

  const fakeNode = (id: string, title: string, content: string, recallCount = 0) => ({
    id,
    title,
    category: 'strategy',
    content,
    color: '#a78bfa',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    recallCount,
  });

  const request = (): any =>
    JSON.parse(fs.readFileSync(path.join(nws, '.nff-brain', 'model-request.json'), 'utf8'));
  const state = (): any =>
    JSON.parse(fs.readFileSync(path.join(nws, '.nff-brain', 'model-state.json'), 'utf8'));
  const promptHook = (prompt: string, sessionId = 'sess-nov') =>
    runCli(['novelty', '--stdin-hook'], {
      stdin: JSON.stringify({ session_id: sessionId, cwd: nws, hook_event_name: 'UserPromptSubmit', prompt }),
      cwd: nws,
    });

  beforeAll(() => {
    nws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-nov-'));
    fs.mkdirSync(path.join(nws, '.git'));
    fs.mkdirSync(path.join(nws, '.nff-brain'));
    const strong = fakeNode(
      'docker-restart',
      'Docker restart procedure',
      'force-recreate wedged containers with compose',
      40,
    );
    const neighbors = Array.from({ length: 7 }, (_, i) => fakeNode(`nb-${i}`, `Neighbor ${i}`, `filler ${i}`));
    fs.writeFileSync(
      path.join(nws, '.nff-brain', 'brain.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        nodes: [strong, ...neighbors],
        edges: neighbors.map((n) => ({ from: 'docker-restart', to: n.id, strength: 0.9 })),
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(nws, { recursive: true, force: true });
  });

  it('recall --stdin-hook writes a session-start model request', () => {
    const payload = JSON.stringify({ session_id: 'sess-nov', cwd: nws, hook_event_name: 'SessionStart' });
    const r = runCli(['recall', '--stdin-hook'], { stdin: payload, cwd: nws });
    expect(r.status).toBe(0);
    const req = request();
    expect(req.version).toBe(1);
    expect(req.source).toBe('session-start');
    expect(req.sessionId).toBe('sess-nov');
    expect(path.resolve(req.cwd)).toBe(path.resolve(nws));
    // The tmpdir-name query matches nothing in the brain → max novelty → frontier.
    expect(req.model).toBe('fable');
    expect(req.novelty).toBe(1);
    // …and the session's tier is seeded so the first prompt has a baseline.
    expect(state().sessions['sess-nov']).toMatchObject({ model: 'fable', belowStreak: 0 });
    // 8-node brain → whole-graph recall event, all seeds.
    const act = lastActivity(nws);
    expect(act.kind).toBe('recall');
    expect(act.ids).toHaveLength(8);
    expect(act.seedCount).toBe(8);
    expect(act.sessionId).toBe('sess-nov');
  });

  it('novelty --stdin-hook stays silent and skips the write when the model is unchanged', () => {
    const before = request();
    const payload = JSON.stringify({
      session_id: 'sess-nov',
      cwd: nws,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'totally unknown protein folding cascade question',
    });
    const r = runCli(['novelty', '--stdin-hook'], { stdin: payload, cwd: nws });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // UserPromptSubmit stdout would leak into context
    expect(request().ts).toBe(before.ts); // still opus → untouched
  });

  it('a familiar prompt arms the downgrade but does not fire it on the first hit', () => {
    const before = request();
    const r = promptHook('docker restart procedure for wedged containers');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Hysteresis: one cheap-looking prompt must not drop the session off the
    // expensive model mid-task, so the request file is untouched…
    expect(request().ts).toBe(before.ts);
    // …but the streak is armed and persisted.
    expect(state().sessions['sess-nov']).toMatchObject({ model: 'fable', belowStreak: 1 });
    // The per-prompt heartbeat fires regardless — the glow is not an auto-model
    // feature.
    const act = lastActivity(nws);
    expect(act.kind).toBe('prompt');
    expect(act.ids[0]).toBe('docker-restart');
    expect(act.sessionId).toBe('sess-nov');
  });

  it('a second familiar prompt in a row completes the downgrade', () => {
    const r = promptHook('docker restart procedure for wedged containers');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const req = request();
    expect(req.source).toBe('prompt');
    expect(req.model).toBe('sonnet');
    expect(req.novelty).toBeLessThan(0.35);
    expect(req.top[0].id).toBe('docker-restart');
    expect(state().sessions['sess-nov']).toMatchObject({ model: 'sonnet', belowStreak: 0 });
  });

  it('a low-signal continuation holds the tier instead of escalating', () => {
    const before = request();
    // "ok" tokenizes to nothing: it only LOOKS maximally novel. Escalating here
    // is the bug this gate exists for.
    for (const prompt of ['ok', 'yes', 'go ahead']) {
      const r = promptHook(prompt);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(request().ts).toBe(before.ts);
    expect(state().sessions['sess-nov'].model).toBe('sonnet');
  });

  it('sessions in one workspace decide independently', () => {
    // sess-b has no history, so it adopts the raw pick and MUST get its own
    // request written even though sess-nov already sits on the same tier.
    const before = request();
    expect(before.model).toBe('sonnet');
    const r = promptHook('docker restart procedure for wedged containers', 'sess-b');
    expect(r.status).toBe(0);
    const req = request();
    expect(req.sessionId).toBe('sess-b');
    expect(req.model).toBe('sonnet');
    expect(req.ts).not.toBe(before.ts); // written, not skipped
    // Both sessions tracked separately.
    expect(Object.keys(state().sessions).sort()).toEqual(['sess-b', 'sess-nov']);
  });

  it('the NFF_BRAIN_SKIP guard blocks the hook write', () => {
    const before = request();
    const payload = JSON.stringify({
      cwd: nws,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'completely different unknown territory again',
    });
    const r = runCli(['novelty', '--stdin-hook'], { stdin: payload, cwd: nws, env: { NFF_BRAIN_SKIP: '1' } });
    expect(r.status).toBe(0);
    expect(request().ts).toBe(before.ts);
  });

  it('interactive novelty --json explains the score', () => {
    const r = runCli(['novelty', '--query', 'docker restart procedure for wedged containers', '--json'], {
      cwd: nws,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.model).toBe('sonnet');
    expect(out.ladder).toEqual(['sonnet', 'opus', 'fable']);
    expect(out.top[0].id).toBe('docker-restart');
    expect(out.hasSignal).toBe(true);
    const empty = runCli(['novelty'], { cwd: nws });
    expect(empty.status).toBe(1);
  });

  it('install-hooks --auto-model wires UserPromptSubmit; uninstall removes all three', () => {
    const r = runCli(['install-hooks', '--auto-model'], { cwd: nws });
    expect(r.status).toBe(0);
    const settingsPath = path.join(nws, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(commands).toContain('nff-brain recall --stdin-hook');
    expect(commands).toContain('nff-brain distill --stdin-hook');
    expect(commands).toContain('nff-brain novelty --stdin-hook');

    const r2 = runCli(['uninstall-hooks'], { cwd: nws });
    expect(r2.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.hooks?.SessionStart ?? []).toEqual([]);
    expect(after.hooks?.UserPromptSubmit ?? []).toEqual([]);
  });
});
