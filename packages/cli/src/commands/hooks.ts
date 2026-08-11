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
  const args = parseArgs(argv);
  const autoModel = args.flags['auto-model'] === true;
  const applyModel = args.flags['apply-model'] === true;
  const settingsPath = settingsPathFor(argv);
  const result = installHooks(settingsPath, { autoModel, applyModel });
  if (result.backedUpTo) console.log(`backed up settings to ${result.backedUpTo}`);
  for (const ev of result.installed) console.log(`wired ${ev} hook in ${settingsPath}`);
  for (const ev of result.skipped) console.log(`${ev} hook already present — skipped`);
  if (result.installed.length) {
    console.log('\nClaude Code will now recall the brain at session start, light up the graph');
    console.log('view as prompts touch nodes, and distill new lessons at session end.');
    console.log('Restart any open Claude Code session to pick this up.');
  }
  if (autoModel && (result.installed.includes('UserPromptSubmit') || result.skipped.includes('UserPromptSubmit'))) {
    console.log('\nauto-model: novelty scoring keeps .nff-brain/model-request.json up to date.');
    console.log('Enable the "nffBrain.autoModel" setting in VS Code so the extension types /model for you.');
    console.log('⚠ That path only works when Claude Code runs in a TERMINAL (claudeCode.useTerminal),');
    console.log('  which is not the default — in the native panel there is no terminal to type into.');
  }
  if (applyModel) {
    if (result.skipped.includes('UserPromptSubmit')) {
      console.log('\n⚠ UserPromptSubmit already had an nff-brain hook, so --apply-model was NOT added.');
      console.log('  Run uninstall-hooks first, or add --apply-model to that command by hand.');
    } else {
      console.log('\napply-model: the prompt hook now writes the chosen tier into .claude/settings.local.json.');
      console.log('Claude Code binds the model at session creation, so each session starts on the tier');
      console.log('the brain settled at during the previous one. Nothing can retier a running session.');
    }
  }
}

export async function cmdUninstallHooks(argv: string[]): Promise<void> {
  const settingsPath = settingsPathFor(argv);
  const removed = uninstallHooks(settingsPath);
  if (removed.length) console.log(`removed nff-brain hooks (${removed.join(', ')}) from ${settingsPath}`);
  else console.log(`no nff-brain hooks found in ${settingsPath}`);
}

export function describeHooks(): {
  path: string;
  sessionStart: boolean;
  sessionEnd: boolean;
  userPromptSubmit: boolean;
}[] {
  const project = projectSettingsPath(resolveBrainPaths(process.cwd()).workspaceRoot);
  const global = globalSettingsPath(os.homedir());
  return [project, global].map((p) => {
    try {
      return { path: p, ...hooksInstalled(p) };
    } catch {
      return { path: p, sessionStart: false, sessionEnd: false, userPromptSubmit: false };
    }
  });
}
