import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISTILL_COMMAND,
  DISTILL_TIMEOUT_S,
  hooksInstalled,
  installHooks,
  localSettingsPath,
  readModelSetting,
  uninstallHooks,
  writeModelSetting,
} from '../src/index.js';

let dir: string;
let settingsPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-hooks-'));
  settingsPath = path.join(dir, '.claude', 'settings.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function read(): any {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

describe('hooksConfig', () => {
  it('installs into a missing settings file', () => {
    const r = installHooks(settingsPath);
    expect(r.installed.sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    const s = read();
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain('nff-brain recall');
    expect(s.hooks.SessionEnd[0].hooks[0].command).toContain('nff-brain distill');
    // The prompt hook is a DEFAULT now (it feeds the graph's activity glow),
    // no longer gated behind --auto-model.
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('nff-brain novelty');
    // Distill MUST carry a timeout: without one Claude Code cancels the
    // SessionEnd hook before the ~25s LLM call finishes.
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(DISTILL_TIMEOUT_S);
    expect(s.hooks.SessionStart[0].hooks[0].timeout).toBeUndefined();
  });

  it('adds the prompt hook to a pre-existing install that lacks it', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'nff-brain recall --stdin-hook' }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: DISTILL_COMMAND, timeout: DISTILL_TIMEOUT_S }] }],
        },
      }),
    );
    const r = installHooks(settingsPath);
    expect(r.installed).toEqual(['UserPromptSubmit']);
    expect(read().hooks.UserPromptSubmit[0].hooks[0].command).toContain('nff-brain novelty');
  });

  it('patches a timeout onto a pre-timeout distill install', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: DISTILL_COMMAND }] }] },
      }),
    );
    const r = installHooks(settingsPath);
    expect(r.skipped).toContain('SessionEnd');
    expect(read().hooks.SessionEnd[0].hooks[0].timeout).toBe(DISTILL_TIMEOUT_S);
  });

  it('merges without clobbering existing hooks and unknown keys', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const existing = {
      permissions: { allow: ['Bash(npm:*)'] },
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing));
    installHooks(settingsPath);
    const s = read();
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(s.hooks.SessionStart).toHaveLength(2); // theirs + ours
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('echo hi');
    // Backup created.
    expect(fs.existsSync(`${settingsPath}.bak-nff-brain`)).toBe(true);
  });

  it('is idempotent', () => {
    installHooks(settingsPath);
    const r2 = installHooks(settingsPath);
    expect(r2.installed).toEqual([]);
    expect(r2.skipped.sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('uninstall removes only nff-brain entries', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
      }),
    );
    installHooks(settingsPath);
    uninstallHooks(settingsPath);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('echo keep-me');
    expect(s.hooks.SessionEnd).toBeUndefined();
    expect(hooksInstalled(settingsPath)).toEqual({
      sessionStart: false,
      sessionEnd: false,
      userPromptSubmit: false,
    });
  });

  it('refuses to touch malformed settings JSON', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{oops');
    expect(() => installHooks(settingsPath)).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{oops'); // untouched
  });
});

// The model setting is the ONLY lever that actually moves a session's model:
// no hook output can set it, terminalSequence is allowlisted to notification
// escapes, and claudeCode.useTerminal defaults to false so there is usually no
// terminal to type /model into. Verified against Claude Code 2.1.228.
describe('writeModelSetting', () => {
  it('creates the file when absent', () => {
    expect(writeModelSetting(settingsPath, 'fable')).toEqual({ previous: null });
    expect(read().model).toBe('fable');
  });

  it('PRESERVES every other key — the permission allowlist lives here', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Read', 'Bash(git:*)'] }, cleanupPeriodDays: 7, hooks: {} }),
    );
    writeModelSetting(settingsPath, 'sonnet');
    const s = read();
    expect(s.model).toBe('sonnet');
    expect(s.permissions.allow).toEqual(['Read', 'Bash(git:*)']);
    expect(s.cleanupPeriodDays).toBe(7);
    expect(s.hooks).toEqual({});
  });

  it('reports the previous tier and skips a no-op rewrite', () => {
    writeModelSetting(settingsPath, 'opus');
    const before = fs.statSync(settingsPath).mtimeMs;
    expect(writeModelSetting(settingsPath, 'opus')).toEqual({ previous: 'opus' });
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before); // untouched
    expect(writeModelSetting(settingsPath, 'fable')).toEqual({ previous: 'opus' });
    expect(read().model).toBe('fable');
  });

  it('refuses to touch malformed settings rather than destroying them', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{oops');
    expect(() => writeModelSetting(settingsPath, 'opus')).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{oops');
  });

  it('readModelSetting reports what Claude Code would launch on', () => {
    expect(readModelSetting(settingsPath)).toBeNull(); // absent → global default
    writeModelSetting(settingsPath, 'sonnet');
    expect(readModelSetting(settingsPath)).toBe('sonnet');
  });

  it('targets settings.local.json, which is gitignored and machine-local', () => {
    expect(localSettingsPath('/ws')).toBe(path.join('/ws', '.claude', 'settings.local.json'));
  });
});
