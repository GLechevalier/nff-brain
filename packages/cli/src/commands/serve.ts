import {
  DEFAULT_SERVE_PORT,
  SERVE_PORT_PROBE_COUNT,
  clearInstance,
  formatPairingCode,
  readInstance,
  resolveBrainPaths,
  writeInstance,
} from '@nff-brain/core';
import type { CaptureTarget } from '@nff-brain/core';
import { PortInUseError, startBrainServer } from '../serve/server.js';
import type { BrainServer } from '../serve/server.js';
import { cliVersion, fail, flagNum, flagStr, parseArgs } from '../util.js';

/** Ask a port whether it is one of ours. Short timeout: this is on startup. */
async function probeHello(port: number): Promise<{ name?: string; serverId?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/hello`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as { name?: string };
  } catch {
    return null;
  }
}

function alreadyRunning(port: number): never {
  const inst = readInstance();
  const where = inst && inst.port === port ? `\n  pid ${inst.pid} · port ${inst.port} · workspace ${inst.workspaceRoot}` : '';
  process.stdout.write(
    `nff-brain serve is already running${where}\n` +
      `The extension is talking to that instance. Stop it there (Ctrl-C),\n` +
      `or start a second one with --port ${port + 1}.\n`,
  );
  // Exit 0, not 1: `nff-brain serve` is then idempotent and safe in a shell
  // alias or a login item.
  process.exit(0);
}

export async function cmdServe(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const quiet = args.flags.quiet === true;

  // `?? DEFAULT`, never `||` — `--port 0` is a legitimate request for an
  // OS-assigned port and 0 is falsy.
  const requested = flagNum(args, 'port');
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 0 || requested > 65535)) {
    fail(`--port must be an integer between 0 and 65535 (got ${flagStr(args, 'port')})`);
  }

  const targetFlag = flagStr(args, 'target');
  if (targetFlag !== undefined && targetFlag !== 'global' && targetFlag !== 'project') {
    fail(`--target must be "global" or "project" (got ${targetFlag})`);
  }
  const defaultTarget = targetFlag as CaptureTarget | undefined;

  // Comma-separated rather than repeatable: parseArgs keeps one value per flag,
  // so `--allow-origin a --allow-origin b` would silently drop the first.
  const allowOrigins = (flagStr(args, 'allow-origin') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const paths = resolveBrainPaths(process.cwd());
  const base = {
    workspaceRoot: paths.workspaceRoot,
    projectBrainPath: paths.project,
    globalBrainPath: paths.global,
    allowOrigins,
    cliVersion: cliVersion(),
    defaultTarget,
  };

  // Port selection. With an explicit --port there is no walking: the user asked
  // for that port and silently using another would be worse than failing.
  let server: BrainServer | undefined;
  if (requested !== undefined) {
    try {
      server = await startBrainServer({ ...base, port: requested });
    } catch (err) {
      if (!(err instanceof PortInUseError)) throw err;
      const hello = await probeHello(requested);
      if (hello?.name === 'nff-brain') alreadyRunning(requested);
      fail(`port ${requested} is in use by another program — pick a different --port`);
    }
  } else {
    for (let i = 0; i < SERVE_PORT_PROBE_COUNT && !server; i++) {
      const port = DEFAULT_SERVE_PORT + i;
      try {
        server = await startBrainServer({ ...base, port });
      } catch (err) {
        if (!(err instanceof PortInUseError)) throw err;
        const hello = await probeHello(port);
        // Never walk PAST one of our own instances — that would create exactly
        // the duplicate this check exists to prevent. Only foreign squatters
        // are stepped over.
        if (hello?.name === 'nff-brain') alreadyRunning(port);
      }
    }
    if (!server) {
      fail(
        `ports ${DEFAULT_SERVE_PORT}-${DEFAULT_SERVE_PORT + SERVE_PORT_PROBE_COUNT - 1} are all in use — ` +
          `free one or pass --port`,
      );
    }
  }

  const { state } = server;
  writeInstance({
    version: 1,
    pid: process.pid,
    port: server.port,
    serverId: state.config().serverId,
    workspaceRoot: paths.workspaceRoot,
    startedAt: state.startedAt,
    cliVersion: base.cliVersion,
  });

  // Auto-open a pairing window only when nothing is paired yet, so a restart
  // during normal use does not print a code nobody asked for.
  const cfg = state.config();
  const code = cfg.clients.length === 0 ? state.openPairing() : null;

  if (quiet) {
    process.stdout.write(`nff-brain serve · http://127.0.0.1:${server.port}\n`);
    if (code) process.stdout.write(`pairing code: ${formatPairingCode(code)}\n`);
  } else {
    const project = state.summarize(paths.project);
    const global = state.summarize(paths.global);
    const queue = state.queueStats();
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const lines = [
      `nff-brain serve · v${base.cliVersion}`,
      `  listening   http://127.0.0.1:${server.port}  (loopback only)`,
      `  workspace   ${paths.workspaceRoot}  (${project.exists ? count(project.nodes, 'node') : 'no brain yet'})`,
      `  global      ${paths.global}  (${global.exists ? count(global.nodes, 'node') : 'no brain yet'})`,
      `  captures    → ${cfg.capture.defaultTarget} brain (queue: ${queue.path}, ${queue.pending} pending)`,
      `  clients     ${cfg.clients.length === 0 ? 'none paired' : count(cfg.clients.length, 'client') + ' paired'}`,
      '',
    ];
    if (code) {
      lines.push(
        `  PAIRING OPEN for 5m — enter this code in the extension popup:`,
        '',
        `      ${formatPairingCode(code)}`,
        '',
        `  (5 wrong attempts closes the window; re-open with \`nff-brain pair\`)`,
        '',
      );
    }
    lines.push('Ctrl-C to stop.', '');
    process.stdout.write(lines.join('\n'));
  }

  // Foreground and blocking: this promise resolves only on shutdown, which is
  // why index.ts's `main().then(flushExit)` does not fire until then. No change
  // is needed there.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (!quiet) process.stdout.write('\nstopping…\n');
      clearInstance();
      void server!.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
