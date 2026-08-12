// The wizard state machine run IN-PROCESS with a scripted fake Ui against a
// synthetic ~/.claude tree and the mocked claude binary. The happy path makes
// the same brain.json assertions as e2eImport's --apply test — proving the
// wizard and the classic path commit identically.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runImportWizard } from '../src/commands/importWizard.js';
import { parseArgs } from '../src/util.js';
import { fakeUi, type Answer } from './fixtures/fakeUi.js';
import { makeClaudeShim, writeOneShot, writeSession } from './fixtures/history.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

let fakeHome: string;
let shimDir: string;
let shimBin: string;
let originalCwd: string;
const savedEnv: Record<string, string | undefined> = {};
const toClean: string[] = [];

function makeWs(name: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `nff-brain-wiz-${name}-`));
  fs.mkdirSync(path.join(ws, '.git'));
  toClean.push(ws);
  return ws;
}

async function wizard(ws: string, script: Answer[]) {
  process.chdir(ws);
  const ui = fakeUi(script);
  await runImportWizard(parseArgs([]), ui);
  return ui;
}

const brainAt = (ws: string) => JSON.parse(fs.readFileSync(path.join(ws, '.nff-brain', 'brain.json'), 'utf8'));
const previewAt = (ws: string) => path.join(ws, '.nff-brain', 'import-preview.md');

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
  originalCwd = process.cwd();
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-wiz-home-'));
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-wiz-shim-'));
  shimBin = makeClaudeShim(shimDir, SHIM_JS);
  for (const [k, v] of Object.entries({
    NFF_BRAIN_CLAUDE_BIN: shimBin,
    NFF_BRAIN_CLAUDE_HOME: fakeHome,
    NFF_BRAIN_TIMEOUT_MS: '5000',
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  process.chdir(originalCwd);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [fakeHome, shimDir, ...toClean]) await rmRetry(dir);
});

describe('import wizard flow (scripted ui, mocked claude)', () => {
  it('happy path: scope → range → mine → review → apply commits like --apply does', async () => {
    const ws = makeWs('happy');
    writeSession(fakeHome, 'wh-alpha', { marker: 'MARKER-ALPHA', title: 'atomic-save-fix', cwd: ws });
    writeSession(fakeHome, 'wh-beta', { marker: 'MARKER-BETA', title: 'packaging-cleanup', cwd: ws });
    writeOneShot(fakeHome, ws, 'wh-oneshot');

    const ui = await wizard(ws, [
      { select: 'this' },
      { select: '30d' },
      { select: 'go' },
      { checklist: 'defaults' },
    ]);

    // Same assertion set as e2eImport's --apply test — wizard ≡ classic path.
    const titles = brainAt(ws).nodes.map((n: { title: string }) => n.title);
    expect(titles).toContain('Bundle the CLI with tsup');
    expect(titles).toContain('Prefers terse commit messages');
    expect(titles).not.toContain('Eyeball the sidebar in VS Code');

    const node = brainAt(ws).nodes.find((n: { title: string }) => n.title === 'Bundle the CLI with tsup');
    expect(node.origin).toBe('import');
    expect(node.importedFrom).toEqual(['wh-alpha']);

    // The preview was consumed by the apply, like the classic flow.
    expect(fs.existsSync(previewAt(ws))).toBe(false);
    expect(ui.asked.some((q) => q.startsWith('Which sessions'))).toBe(true);
    // The final "your brain now knows N things" summary comes from applyPhase
    // on stdout — the wizard adds no apply output of its own.
  }, 30_000);

  it('back from the range step returns to the scope step', async () => {
    const ws = makeWs('back');
    writeSession(fakeHome, 'wb-alpha', { marker: 'MARKER-ALPHA', title: 'a', cwd: ws });

    const ui = await wizard(ws, [
      { select: 'this' },
      { select: 'back' },
      { select: 'cancel' }, // back at scope — leave
    ]);

    const scopeAsks = ui.asked.filter((q) => q.startsWith('Which sessions'));
    expect(scopeAsks.length).toBe(2);
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'brain.json'))).toBe(false);
  }, 30_000);

  it('cancelling the review keeps the preview as a receipt, brain untouched', async () => {
    const ws = makeWs('cancelrev');
    writeSession(fakeHome, 'wc-alpha', { marker: 'MARKER-ALPHA', title: 'a', cwd: ws });

    const ui = await wizard(ws, [
      { select: 'this' },
      { select: '30d' },
      { select: 'go' },
      { checklist: null }, // Esc at the review
    ]);

    expect(fs.existsSync(previewAt(ws))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'brain.json'))).toBe(false);
    expect(ui.notes.join('\n')).toContain('import --apply');
  }, 30_000);

  it('a waiting preview opens the resume menu; review-and-apply commits it', async () => {
    const ws = makeWs('resume');
    writeSession(fakeHome, 'wr-alpha', { marker: 'MARKER-ALPHA', title: 'a', cwd: ws });

    // First run leaves a preview behind (cancelled review).
    await wizard(ws, [{ select: 'this' }, { select: '30d' }, { select: 'go' }, { checklist: null }]);

    // Second run must open on the resume select, not re-scan.
    const ui = await wizard(ws, [{ select: 'review' }, { checklist: 'defaults' }]);
    expect(ui.asked[0]).toContain('preview from');
    expect(brainAt(ws).nodes.map((n: { title: string }) => n.title)).toContain('Bundle the CLI with tsup');
    expect(fs.existsSync(previewAt(ws))).toBe(false);
  }, 30_000);

  it('an empty scope offers recovery instead of a dead end', async () => {
    const ws = makeWs('empty');
    // Sessions exist only in ANOTHER project, so the machine-wide survey finds
    // work but "this project" has none.
    writeSession(fakeHome, 'we-other', {
      marker: 'MARKER-ALPHA',
      title: 'elsewhere',
      cwd: path.join(os.tmpdir(), 'nff-brain-wiz-other-repo'),
    });

    const ui = await wizard(ws, [
      { select: 'this' },
      { select: '30d' },
      { select: 'quit' }, // the recovery select
    ]);

    expect(ui.asked.at(-1)).toContain('what next?');
    expect(ui.optionsSeen.at(-1)).toContain('Pick a different scope');
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'brain.json'))).toBe(false);
  }, 30_000);

  it('the every-project scope carries the disclosure warning', async () => {
    const ws = makeWs('all');
    writeSession(fakeHome, 'wa-alpha', { marker: 'MARKER-ALPHA', title: 'a', cwd: ws });

    const ui = await wizard(ws, [
      { select: 'all' },
      { select: '30d' },
      { select: 'cancel' }, // read the warning, then leave
    ]);

    expect(ui.notes.join('\n')).toContain('EVERY project');
    expect(fs.existsSync(path.join(ws, '.nff-brain', 'brain.json'))).toBe(false);
  }, 30_000);
});
