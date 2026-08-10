import * as os from 'node:os';
import {
  globalSettingsPath,
  hooksInstalled,
  installHooks,
  projectSettingsPath,
  resolveBrainPaths,
  uninstallHooks,
} from '@nff-brain/core';
import { parseArgs } from '../util.js';

function settingsPathFor(argv: string[]): string {
  const args = parseArgs(argv);
  if (args.flags.global === true) return globalSettingsPath(os.homedir());
  return projectSettingsPath(resolveBrainPaths(process.cwd()).workspaceRoot);
}

export async function cmdInstallHooks(argv: string[]): Promise<void> {
  const settingsPath = settingsPathFor(argv);
  const result = installHooks(settingsPath);
  if (result.backedUpTo) console.log(`backed up settings to ${result.backedUpTo}`);
  for (const ev of result.installed) console.log(`wired ${ev} hook in ${settingsPath}`);
  for (const ev of result.skipped) console.log(`${ev} hook already present — skipped`);
  if (result.installed.length) {
    console.log('\nClaude Code will now recall the brain at session start and distill new');
    console.log('lessons at session end. Restart any open Claude Code session to pick this up.');
  }
}

export async function cmdUninstallHooks(argv: string[]): Promise<void> {
  const settingsPath = settingsPathFor(argv);
  const removed = uninstallHooks(settingsPath);
  if (removed.length) console.log(`removed nff-brain hooks (${removed.join(', ')}) from ${settingsPath}`);
  else console.log(`no nff-brain hooks found in ${settingsPath}`);
}

export function describeHooks(): { path: string; sessionStart: boolean; sessionEnd: boolean }[] {
  const project = projectSettingsPath(resolveBrainPaths(process.cwd()).workspaceRoot);
  const global = globalSettingsPath(os.homedir());
  return [project, global].map((p) => {
    try {
      return { path: p, ...hooksInstalled(p) };
    } catch {
      return { path: p, sessionStart: false, sessionEnd: false };
    }
  });
}
