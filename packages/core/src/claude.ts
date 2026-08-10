import { spawn } from 'node:child_process';

// The ONLY subprocess module. One `claude -p` call per command, prompt via
// stdin (no shell-quoting hell, no arg-length limits), hard timeout, and the
// caller decides whether a failure is fatal (hooks are fail-open).

export interface ClaudeOptions {
  model?: string; // claude CLI model alias or full id
  timeoutMs?: number;
  claudeBin?: string; // override for tests (the mocked shim)
}

export type OneShot = (prompt: string) => Promise<string>;

export async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  const model = opts.model ?? process.env.NFF_BRAIN_MODEL ?? 'haiku';
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.NFF_BRAIN_TIMEOUT_MS) || 60_000);
  const bin = opts.claudeBin ?? process.env.NFF_BRAIN_CLAUDE_BIN ?? 'claude';

  return new Promise<string>((resolve, reject) => {
    // shell:true lets Windows resolve claude.cmd; every arg is a fixed literal.
    // NFF_BRAIN_SKIP guards against recursion: this claude run fires Claude Code
    // hooks of its own, and our SessionStart/SessionEnd hook commands exit
    // immediately when they see it.
    const child = spawn(bin, ['-p', '--model', model, '--output-format', 'text'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NFF_BRAIN_SKIP: '1' },
    });

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the whole tree and drop our ends of the pipes — with shell:true a
      // plain kill() only takes out the shell, and the orphaned grandchild
      // would otherwise hold our stdio open and keep the process alive forever.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).unref();
        } catch {
          /* best effort */
        }
      }
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 500)}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Bind options once so distill/merge receive a plain prompt→text function. */
export function makeOneShot(opts: ClaudeOptions = {}): OneShot {
  return (prompt) => runClaude(prompt, opts);
}
