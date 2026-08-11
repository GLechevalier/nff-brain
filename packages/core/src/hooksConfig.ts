import * as fs from 'node:fs';
import * as path from 'node:path';

// Safe editing of Claude Code's settings.json hook config. The cardinal rule:
// MERGE, never clobber — users have their own hooks and unknown keys in there.
// We only ever append our two entries (identified by 'nff-brain' in the command)
// and only ever remove entries whose command contains 'nff-brain'.

export const RECALL_COMMAND = 'nff-brain recall --stdin-hook';
export const DISTILL_COMMAND = 'nff-brain distill --stdin-hook';
// Installed by default: re-score novelty against each real user prompt.
// LLM-free, sub-100ms, silent on stdout (UserPromptSubmit stdout would be
// injected into context). It feeds two consumers: the per-prompt activity
// event (nodes light up in the graph webview as the agent "thinks" of them)
// and .nff-brain/model-request.json (only ACTED on when the user opted into
// auto-model in the extension).
export const NOVELTY_COMMAND = 'nff-brain novelty --stdin-hook';
// Without an explicit timeout Claude Code cancels SessionEnd hooks after a
// short grace (<20s, proven in print mode) — a real haiku distill takes ~25s,
// so the brain would silently never learn. 120s covers the 60s inner LLM
// timeout plus startup slack.
export const DISTILL_TIMEOUT_S = 120;

const MARKER = 'nff-brain';

interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

interface SettingsShape {
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.claude', 'settings.json');
}

export function globalSettingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

function readSettings(filePath: string): SettingsShape {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SettingsShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err; // malformed JSON: refuse to touch it rather than destroy it
  }
}

function writeSettings(filePath: string, settings: SettingsShape): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function hasMarkerHook(matchers: HookMatcher[] | undefined): boolean {
  for (const m of matchers ?? []) {
    for (const h of m.hooks ?? []) {
      if (typeof h.command === 'string' && h.command.includes(MARKER)) return true;
    }
  }
  return false;
}

export interface InstallResult {
  installed: string[]; // event names newly wired
  skipped: string[]; // event names that already had an nff-brain hook
  backedUpTo?: string;
}

export function installHooks(settingsPath: string, opts: { autoModel?: boolean } = {}): InstallResult {
  const settings = readSettings(settingsPath);
  const result: InstallResult = { installed: [], skipped: [] };

  // One-time backup before our first ever edit of this file.
  const backup = `${settingsPath}.bak-nff-brain`;
  if (fs.existsSync(settingsPath) && !fs.existsSync(backup)) {
    fs.copyFileSync(settingsPath, backup);
    result.backedUpTo = backup;
  }

  settings.hooks = settings.hooks ?? {};
  const wanted: Array<[string, string, number | undefined]> = [
    ['SessionStart', RECALL_COMMAND, undefined],
    ['SessionEnd', DISTILL_COMMAND, DISTILL_TIMEOUT_S],
    // Always wired: the prompt hook drives the graph's live activity glow.
    // --auto-model no longer gates installation, only the extension's typing.
    ['UserPromptSubmit', NOVELTY_COMMAND, undefined],
  ];
  let patched = false;
  for (const [event, command, timeout] of wanted) {
    const matchers = (settings.hooks[event] = settings.hooks[event] ?? []);
    if (hasMarkerHook(matchers)) {
      // Repair pre-timeout installs in place: without it the distill hook is
      // cancelled at session end and nothing is ever learned.
      if (timeout !== undefined) {
        for (const m of matchers) {
          for (const h of m.hooks ?? []) {
            if (typeof h.command === 'string' && h.command.includes(MARKER) && h.timeout === undefined) {
              h.timeout = timeout;
              patched = true;
            }
          }
        }
      }
      result.skipped.push(event);
      continue;
    }
    const entry: HookEntry = { type: 'command', command };
    if (timeout !== undefined) entry.timeout = timeout;
    matchers.push({ hooks: [entry] });
    result.installed.push(event);
  }

  if (result.installed.length || patched) writeSettings(settingsPath, settings);
  return result;
}

export function uninstallHooks(settingsPath: string): string[] {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return [];
  const removed: string[] = [];
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).filter(
          (h) => !(typeof h.command === 'string' && h.command.includes(MARKER)),
        ),
      }))
      // Drop matcher blocks that only existed to hold our hook.
      .filter((m) => (m.hooks?.length ?? 0) > 0 || Object.keys(m).some((k) => k !== 'hooks' && k !== 'matcher'));
    if (kept.length !== matchers.length || JSON.stringify(kept) !== JSON.stringify(matchers)) {
      settings.hooks[event] = kept;
      removed.push(event);
    }
    if (kept.length === 0) delete settings.hooks[event];
  }
  if (removed.length) writeSettings(settingsPath, settings);
  return removed;
}

export function hooksInstalled(settingsPath: string): {
  sessionStart: boolean;
  sessionEnd: boolean;
  userPromptSubmit: boolean;
} {
  const settings = readSettings(settingsPath);
  return {
    sessionStart: hasMarkerHook(settings.hooks?.SessionStart),
    sessionEnd: hasMarkerHook(settings.hooks?.SessionEnd),
    userPromptSubmit: hasMarkerHook(settings.hooks?.UserPromptSubmit),
  };
}
