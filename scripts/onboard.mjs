#!/usr/bin/env node
// The one command a fresh clone runs: `npm run onboard`.
//
// This is phase A — mechanical, non-interactive, must work before `nff-brain`
// exists anywhere on PATH: install deps, build every package, link the CLI
// globally. It then hands off to phase B, the interactive wizard
// (`nff-brain onboard`, packages/cli/src/commands/onboard.ts), invoked
// directly off dist/ rather than through PATH so the handoff never depends on
// the just-created global link having propagated yet.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(label, cmd, args) {
  console.log(`\n▸ ${label}`);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\nonboard: "${label}" failed (exit ${r.status}) — fix the error above and re-run \`npm run onboard\`.`);
    process.exit(r.status ?? 1);
  }
}

step('installing dependencies', npmCmd, ['ci']);
step('building core, CLI, VS Code and Chrome packages', npmCmd, ['run', 'build']);
step('linking the nff-brain CLI globally', npmCmd, ['link', '--workspace', 'packages/cli']);

console.log('\n▸ CLI built and linked — continuing with guided setup\n');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const wizard = spawnSync(process.execPath, [cliEntry, 'onboard'], { cwd: repoRoot, stdio: 'inherit' });
process.exit(wizard.status ?? 0);
