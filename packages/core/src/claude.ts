import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// The ONLY subprocess module. One `claude -p` call per command, prompt via
// stdin (no shell-quoting hell, no arg-length limits), hard timeout, and the
// caller decides whether a failure is fatal (hooks are fail-open).
// ClaudeSession is the one exception to "one call per command": a long-lived
// `claude -p --input-format stream-json` conversation, one process for a whole
// web-agent run, so each turn pays model inference instead of a CLI cold start.

// Kill the whole tree and drop our ends of the pipes — with shell:true a
// plain kill() only takes out the shell, and the orphaned grandchild
// would otherwise hold our stdio open and keep the process alive forever.
function killProcessTree(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
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
}

export interface ClaudeOptions {
  model?: string; // claude CLI model alias or full id
  timeoutMs?: number;
  claudeBin?: string; // override for tests (the mocked shim)
  /** Abort kills the child tree immediately (wizard Ctrl-C). */
  signal?: AbortSignal;
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

    const unlisten = (): void => opts.signal?.removeEventListener('abort', onAbort);

    const killTree = (reason: string): void => {
      if (settled) return;
      settled = true;
      unlisten();
      killProcessTree(child);
      reject(new Error(reason));
    };

    const timer = setTimeout(() => killTree(`claude -p timed out after ${timeoutMs}ms`), timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      killTree('claude -p aborted');
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten();
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten();
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

export interface ClaudeSessionOptions {
  model?: string; // claude CLI model alias or full id
  claudeBin?: string; // override for tests (the mocked shim)
  /** Per-send cap — a turn that blows this kills the whole session. */
  sendTimeoutMs?: number;
}

interface PendingSend {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A long-lived `claude -p` conversation over stream-json stdin/stdout. Spawned
 * lazily on the first send; each send() writes ONE user message line and
 * resolves with that turn's result text. Claude Code holds the conversation
 * state itself, so callers send only the new observation each turn — the fixed
 * prefix stays prompt-cached instead of being re-tokenized per action.
 *
 * Any failure (per-send timeout, process death, non-success result) kills the
 * session: `alive` turns false and the OWNER respawns and replays. Sends are
 * chained so a second send queues behind the first.
 */
export class ClaudeSession {
  private child: ChildProcess | null = null;
  private dead = false;
  private stdoutBuf = '';
  private stderrTail = '';
  private pending: PendingSend | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly model: string;
  private readonly bin: string;
  private readonly sendTimeoutMs: number;

  constructor(opts: ClaudeSessionOptions = {}) {
    this.model = opts.model ?? process.env.NFF_BRAIN_MODEL ?? 'haiku';
    this.bin = opts.claudeBin ?? process.env.NFF_BRAIN_CLAUDE_BIN ?? 'claude';
    this.sendTimeoutMs = opts.sendTimeoutMs ?? (Number(process.env.NFF_BRAIN_TIMEOUT_MS) || 60_000);
  }

  /** False once the process died or a send failed — the session is unusable. */
  get alive(): boolean {
    return !this.dead;
  }

  send(userText: string): Promise<string> {
    const next = this.chain.then(
      () => this.sendNow(userText),
      () => this.sendNow(userText),
    );
    // Park a handler so an abandoned rejection never surfaces as unhandled.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Idempotent teardown; fails any in-flight send. */
  end(): void {
    this.fail(new Error('claude session ended'));
  }

  private sendNow(userText: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.dead) {
        reject(new Error('claude session is dead'));
        return;
      }
      if (!this.child) this.start();
      const child = this.child!;
      const timer = setTimeout(() => {
        this.fail(new Error(`claude session turn timed out after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      this.pending = { resolve, reject, timer };
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } });
      // Never stdin.end() — the open pipe is what keeps the conversation going.
      child.stdin?.write(line + '\n', (err) => {
        if (err) this.fail(new Error(`claude session write failed: ${err.message}`));
      });
    });
  }

  private start(): void {
    // Same spawn shape as runClaude: shell:true resolves claude.cmd on Windows
    // and every arg is a fixed literal; NFF_BRAIN_SKIP guards hook recursion.
    // --verbose is required by stream-json print mode; --no-session-persistence
    // keeps agent runs from littering ~/.claude with resumable sessions.
    const child = spawn(
      this.bin,
      ['-p', '--model', this.model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
      {
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NFF_BRAIN_SKIP: '1' },
      },
    );
    this.child = child;

    child.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-500);
    });
    child.on('error', (e) => this.fail(new Error(`claude session failed to start: ${e.message}`)));
    child.on('close', (code) => this.fail(new Error(`claude session exited ${code}: ${this.stderrTail}`)));
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // not ours (stray CLI noise) — the result line is what matters
      }
      // Only the per-turn result line matters; system/assistant lines are
      // progress we don't need, and unknown types are future CLI additions.
      if (msg.type !== 'result' || !this.pending) continue;
      const { resolve, timer } = this.pending;
      clearTimeout(timer);
      const text = typeof msg.result === 'string' ? msg.result : '';
      if (msg.subtype === 'success' && msg.is_error !== true) {
        this.pending = null;
        resolve(text);
      } else {
        // A failed turn poisons the conversation — kill the session so the
        // owner respawns fresh rather than continuing on a broken state.
        this.fail(new Error(`claude session turn failed (${String(msg.subtype)}): ${text.slice(0, 300)}`));
      }
    }
  }

  private fail(err: Error): void {
    if (this.dead) {
      // Still deliver to a pending send that raced the death (defensive).
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(err);
        this.pending = null;
      }
      return;
    }
    this.dead = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    if (this.child) killProcessTree(this.child);
    this.child = null;
  }
}
