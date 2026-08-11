import * as fs from 'node:fs';
import * as path from 'node:path';
import { brainLogPath } from '@nff-brain/core';

// Tiny flag parser: `--key value` / `--key=value` / boolean `--flag`, plus positionals.
export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  'query', 'transcript', 'session', 'title', 'category', 'content', 'id', 'strength', 'delta', 'ratio', 'model', 'limit',
]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

export function flagStr(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagNum(args: Args, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read all of stdin (hook payloads), giving up quietly after a short timeout. */
export function readStdin(timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        // Release stdin or the (fail-open, must-exit) hook process never dies.
        try {
          process.stdin.destroy();
        } catch {
          /* already closed */
        }
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Append to the fail-open log next to the brain file. Never throws. */
export function logToBrainDir(brainPath: string, name: string, message: string): void {
  try {
    const p = brainLogPath(brainPath, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* truly nothing left to do */
  }
}

export function fail(message: string): never {
  console.error(`nff-brain: ${message}`);
  process.exit(1);
}

/** CLI version from package.json — one level above the bundled dist/index.js. */
export function cliVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
