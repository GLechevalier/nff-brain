import { spawnSync } from 'node:child_process';
import { cliVersion, fail } from '../util.js';

// `nff-brain upgrade` — pull the latest published build over this install.

export async function cmdUpgrade(): Promise<void> {
  console.log(`current: nff-brain v${cliVersion()}`);
  console.log('running: npm install -g nff-brain@latest');
  const result = spawnSync('npm', ['install', '-g', 'nff-brain@latest'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail('upgrade failed — run `npm install -g nff-brain@latest` manually');
  }
  console.log('upgraded — check with `nff-brain --version`');
}
