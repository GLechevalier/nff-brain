import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeClaudeShim, writeOneShot, writeSession as writeSessionIn } from './fixtures/history.js';

// End-to-end for `nff-brain import` over the BUILT CLI (run
// `npm run build -w nff-brain` first) against a SYNTHETIC ~/.claude tree and
// the mocked claude binary. Kept in its own file with its own workspace so the
// session-loop suite in e2e.test.ts is untouched by it.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

let ws: string; // isolated fake workspace
let fakeHome: string; // isolated fake ~/.claude
let shimDir: string;
let shimBin: string;

function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ws,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NFF_BRAIN_CLAUDE_BIN: shimBin,
      NFF_BRAIN_TIMEOUT_MS: '5000',
      NFF_BRAIN_SKIP: '',
      NFF_BRAIN_CLAUDE_HOME: fakeHome,
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const writeSession = (sessionId: string, opts: { marker?: string; title?: string; cwd: string }): void =>
  writeSessionIn(fakeHome, sessionId, opts);

const previewPath = () => path.join(ws, '.nff-brain', 'import-preview.md');
const preview = () => fs.readFileSync(previewPath(), 'utf8');
const brain = () => JSON.parse(fs.readFileSync(path.join(ws, '.nff-brain', 'brain.json'), 'utf8'));

async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);

  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-imp-'));
  fs.mkdirSync(path.join(ws, '.git')); // workspace-root marker
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-home-'));

  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-impshim-'));
  shimBin = makeClaudeShim(shimDir, SHIM_JS);

  writeSession('sess-alpha', { marker: 'MARKER-ALPHA', title: 'atomic-save-fix', cwd: ws });
  writeSession('sess-beta', { marker: 'MARKER-BETA', title: 'packaging-cleanup', cwd: ws });
  writeSession('sess-quiet', { title: 'routine-chore', cwd: ws }); // shim yields nothing

  // nff-brain's OWN claude -p call. Its project folder holds these alongside
  // real sessions, and mining one back in would feed the brain its own prompt.
  writeOneShot(fakeHome, ws);

  // A different project — out of scope for the default run.
  writeSession('sess-elsewhere', {
    marker: 'MARKER-ALPHA',
    title: 'other-repo',
    cwd: path.join(os.tmpdir(), 'nff-brain-some-other-repo'),
  });
});

afterAll(async () => {
  for (const dir of [ws, fakeHome, shimDir]) await rmRetry(dir);
});

describe('e2e import (mocked claude)', () => {
  it('writes a preview and leaves the brain completely untouched', () => {
    const r = runCli(['import']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(previewPath())).toBe(true);
    // Phase one must never write knowledge — the preview IS the consent step.
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'brain.json'))).toBe(false);
    expect(r.stdout).toContain('import --apply');
  });

  it('skips one-shot claude -p transcripts and other projects', () => {
    expect(preview()).not.toContain('memory distiller');
    expect(preview()).not.toContain('other-repo');
  });

  it('clusters the same lesson across two sessions and boosts its confidence', () => {
    const md = preview();
    // 0.5 from each of two sessions → 0.65 after the boost.
    expect(md).toMatch(/Retry renameSync[^\n]*`0\.6\d`/);
    expect(md).toContain('2 sessions');
  });

  it('renders a low-confidence item unchecked and a confident one checked', () => {
    const md = preview();
    expect(md).toMatch(/- \[x\] \*\*Bundle the CLI with tsup\*\*/);
    expect(md).toMatch(/- \[ \] \*\*Eyeball the sidebar in VS Code\*\*/);
  });

  it('groups items under their kind headings', () => {
    const md = preview();
    expect(md).toContain('## Durable memories');
    expect(md).toContain('## Architectural decisions');
    expect(md).toContain('## Developer preferences');
    expect(md).toContain('## Unresolved tasks');
  });

  it('refuses to overwrite an unreviewed preview without --force', () => {
    const r = runCli(['import']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already waiting');
  });

  it('--apply commits only the checked items, with origin import and confidence', () => {
    const r = runCli(['import', '--apply']);
    expect(r.status).toBe(0);
    const titles = brain().nodes.map((n: { title: string }) => n.title);
    expect(titles).toContain('Bundle the CLI with tsup');
    expect(titles).toContain('Prefers terse commit messages');
    // The 0.3-confidence task rendered unchecked, so it must not be committed.
    expect(titles).not.toContain('Eyeball the sidebar in VS Code');

    const node = brain().nodes.find((n: { title: string }) => n.title === 'Bundle the CLI with tsup');
    expect(node.origin).toBe('import');
    expect(node.category).toBe('decision');
    expect(typeof node.confidence).toBe('number');
    expect(node.importedFrom).toEqual(['sess-alpha']);
  });

  it('consumes the preview so the same batch cannot be applied twice', () => {
    expect(fs.existsSync(previewPath())).toBe(false);
    const r = runCli(['import', '--apply']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no import preview');
  });

  it('reports no new sessions once every session has been mined', () => {
    const r = runCli(['import']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no new sessions');
  });

  it('a NEW session does not re-offer a lesson already accepted', () => {
    // The proposal ledger's real job: fresh sessions restate the same house
    // rules forever, and re-offering them every run is what makes an importer
    // annoying enough to stop using. This session repeats MARKER-ALPHA's.
    writeSession('sess-later', { marker: 'MARKER-ALPHA', title: 'more-work', cwd: ws });
    const r = runCli(['import']);
    expect(r.status).toBe(0);
    expect(preview()).not.toContain('Bundle the CLI with tsup');
    runCli(['import', '--force']); // leave no preview for the next test
  });

  it('--force re-offers everything, so a deleted node can be recovered', () => {
    // The counterpart to the rule above: --force is the escape hatch, and it
    // must ignore BOTH guards or there is no way to get a memory back.
    const r = runCli(['import', '--force']);
    expect(r.status).toBe(0);
    expect(preview()).toContain('Bundle the CLI with tsup');
  });

  it('applying again creates no duplicate node ids', () => {
    runCli(['import', '--apply']);
    const ids = brain().nodes.map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says so plainly when a workspace has no history at all', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-bare-'));
    fs.mkdirSync(path.join(bare, '.git'));
    const r = runCli(['import'], { cwd: bare });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no past sessions found/);
    await rmRetry(bare);
  });

  it('stays non-interactive when stdio is piped — no ANSI escapes anywhere', () => {
    // spawnSync pipes stdio, so isTTY is false in the child; the wizard gate
    // must stay closed and the classic byte-for-byte output must come back.
    const r = runCli(['import', '--force']);
    expect(r.stdout + r.stderr).not.toMatch(/\u001b\[/);
  });

  it('fails open when the LLM hangs — exit 0, and no brain is written', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-e2e-hang-'));
    fs.mkdirSync(path.join(bare, '.git'));
    writeSession('sess-hang', { marker: 'MARKER-ALPHA', title: 'will-hang', cwd: bare });
    const r = runCli(['import'], { cwd: bare, env: { SHIM_MODE: 'hang' } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(bare, '.nff-brain', 'brain.json'))).toBe(false);
    await rmRetry(bare);
  });
});
