import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISTILL_COMMAND, DISTILL_TIMEOUT_S, hooksInstalled, installHooks, uninstallHooks } from '../src/index.js';

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
    expect(r.installed.sort()).toEqual(['SessionEnd', 'SessionStart']);
    const s = read();
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain('nff-brain recall');
    expect(s.hooks.SessionEnd[0].hooks[0].command).toContain('nff-brain distill');
    // Distill MUST carry a timeout: without one Claude Code cancels the
    // SessionEnd hook before the ~25s LLM call finishes.
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(DISTILL_TIMEOUT_S);
    expect(s.hooks.SessionStart[0].hooks[0].timeout).toBeUndefined();
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
    expect(r2.skipped.sort()).toEqual(['SessionEnd', 'SessionStart']);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
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
    expect(hooksInstalled(settingsPath)).toEqual({ sessionStart: false, sessionEnd: false });
  });

  it('refuses to touch malformed settings JSON', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{oops');
    expect(() => installHooks(settingsPath)).toThrow();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{oops'); // untouched
  });
});
