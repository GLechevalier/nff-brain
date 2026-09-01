import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInstanceAlive, readInstance } from '@nff-brain/core';
import { parseArgs } from '../util.js';
import { createTerminalUi, type WizardUi } from '../tui/wizardUi.js';
import { shouldRunWizard } from './importPlan.js';
import { cmdDoctor } from './doctor.js';
import { cmdInit } from './init.js';
import { cmdPair } from './pair.js';

// `nff-brain onboard` — the guided setup a fresh clone runs once, right after
// `npm run onboard` (repo-root scripts/onboard.mjs) builds and links the CLI.
// Walks VS Code + Chrome as explicit yes/no steps, offers to wire hooks into
// a project, and finishes with `doctor` as the health readout.
//
// Ground rules, matching the import wizard (importWizard.ts):
//  - non-interactive (CI, piped, any flag) → skip straight to `doctor`, never
//    block on a prompt. shouldRunWizard is the exact gate `import` uses.
//  - VS Code / Chrome steps only offer themselves when packages/vscode or
//    packages/chrome/dist exist next to cwd — a real npm install of the
//    published `nff-brain` package ships neither, so they're skipped there.

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    shell: process.platform === 'win32',
    windowsHide: true,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function onPath(cmd: string): boolean {
  return run(cmd, ['--version'], { timeoutMs: 15_000 }).status === 0;
}

export async function cmdOnboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (
    !shouldRunWizard({
      args,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      stderrTTY: process.stderr.isTTY === true,
      env: process.env,
    })
  ) {
    console.log('non-interactive — skipping the guided setup, running the health check only.');
    return cmdDoctor();
  }

  const ui = await createTerminalUi();
  try {
    await runWizard(ui);
  } finally {
    ui.close();
  }
}

async function runWizard(ui: WizardUi): Promise<void> {
  const repoRoot = process.cwd();
  const { style: st, glyphs: g } = ui;
  ui.note(`${st.accent(st.bold('nff-brain onboard'))} ${st.dim(`${g.dot} the CLI is built and linked — let's wire up the rest`)}`);
  ui.note();

  await stepVSCode(repoRoot, ui);
  ui.note();
  await stepChrome(repoRoot, ui);
  ui.note();
  await stepProject(ui);

  ui.note();
  ui.note(st.bold('Health check'));
  await cmdDoctor(); // prints its own summary; exits 1 if something load-bearing is broken
}

async function stepVSCode(repoRoot: string, ui: WizardUi): Promise<void> {
  const { style: st, glyphs: g } = ui;
  const vscodeDir = path.join(repoRoot, 'packages', 'vscode');
  if (!fs.existsSync(vscodeDir)) {
    ui.note(st.dim('VS Code extension: not available from this install — skipped.'));
    return;
  }
  const wants = await ui.confirm('Install the VS Code extension?', { initial: true });
  if (!wants) return;

  const spin = ui.spinner('packaging the VS Code extension (vsce)…');
  const pkg = run('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies'], { cwd: vscodeDir });
  if (pkg.status !== 0) {
    spin.stop(`${st.err(g.cross)} vsce package failed: ${(pkg.stderr || pkg.stdout).trim().slice(-400)}`);
    return;
  }
  const vsix = fs.readdirSync(vscodeDir).find((f) => f.endsWith('.vsix'));
  if (!vsix) {
    spin.stop(`${st.err(g.cross)} vsce reported success but produced no .vsix in ${vscodeDir}`);
    return;
  }
  const vsixPath = path.join(vscodeDir, vsix);
  spin.stop(`${st.ok(g.check)} packaged ${vsix}`);

  if (onPath('code')) {
    const auto = await ui.confirm('Install it now via the `code` CLI?', { initial: true });
    if (auto) {
      const inst = run('code', ['--install-extension', vsixPath]);
      if (inst.status === 0) {
        ui.note(`${st.ok(g.check)} installed into VS Code — reload any open window to pick it up.`);
        return;
      }
      ui.note(`${st.warn('⚠')} \`code --install-extension\` failed — install it manually instead.`);
    }
  }
  ui.note(`  open VS Code → Extensions view → "…" menu → Install from VSIX… → ${vsixPath}`);
  await ui.confirm('Done?', { initial: true });
}

async function stepChrome(repoRoot: string, ui: WizardUi): Promise<void> {
  const { style: st } = ui;
  const chromeDist = path.join(repoRoot, 'packages', 'chrome', 'dist');
  if (!fs.existsSync(chromeDist)) {
    ui.note(st.dim('Chrome extension: not available from this install — skipped.'));
    return;
  }
  const wants = await ui.confirm('Install the Chrome extension?', { initial: true });
  if (!wants) return;

  ui.note('  1. open chrome://extensions');
  ui.note('  2. turn on "Developer mode" (top right)');
  ui.note(`  3. click "Load unpacked" and select: ${chromeDist}`);
  await ui.confirm('Done?', { initial: true });

  const wantsPair = await ui.confirm('Pair it with this machine now?', { initial: true });
  if (!wantsPair) return;

  const inst = readInstance();
  if (!inst || !isInstanceAlive(inst)) {
    ui.note('  the extension pairs with a local server — start it in another terminal:');
    ui.note('    nff-brain serve');
    ui.note('  then finish pairing here:');
    ui.note('    nff-brain pair');
    return;
  }
  await cmdPair([]);
  ui.note(`  open the extension's popup → Settings → Pair, and enter the code above.`);
  await ui.confirm('Paired?', { initial: true });
}

async function stepProject(ui: WizardUi): Promise<void> {
  const { style: st, glyphs: g } = ui;
  const wants = await ui.confirm('Wire nff-brain into a project now (install hooks + init)?', { initial: true });
  if (!wants) return;

  const originalCwd = process.cwd();
  const projectPath = await ui.text('Project path', { default: originalCwd });
  if (projectPath === null) return;
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    ui.note(`${st.err(g.cross)} ${resolved} does not exist — skipped.`);
    return;
  }

  process.chdir(resolved);
  try {
    await cmdInit(['--hooks']);
  } finally {
    process.chdir(originalCwd);
  }
}
