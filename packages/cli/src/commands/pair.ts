import {
  formatPairingCode,
  loadServeConfig,
  mintServerIdentity,
  saveServeConfig,
  serveConfigPath,
} from '@nff-brain/core';
import { flagStr, parseArgs } from '../util.js';
import { admin } from './adminHttp.js';

// `nff-brain pair` drives the RUNNING server over its own admin routes rather
// than editing serve.json underneath it — otherwise a code opened here would
// live in a different process's memory than the one answering /v1/pair.
//
// The exception is --reset, which must work with the server down (that is when
// you most want it). It rewrites the file directly; the server notices via the
// mtime check in ServeState.config() within a second.

export async function cmdPair(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.flags.reset === true) {
    // Works offline by design. Rotating serverId and adminToken alongside the
    // client list means a leaked admin token cannot outlive a reset.
    const fresh = mintServerIdentity();
    const previous = loadServeConfig();
    if (previous) fresh.capture.defaultTarget = previous.capture.defaultTarget;
    saveServeConfig(fresh);
    process.stdout.write(
      `reset ${serveConfigPath()} — ${previous?.clients.length ?? 0} client(s) revoked, server identity rotated\n` +
        `restart \`nff-brain serve\` and re-pair the extension\n`,
    );
    return;
  }

  if (args.flags.list === true) {
    const { clients } = await admin<{ clients: { id: string; name: string; origin: string; createdAt: string }[] }>({
      path: '/v1/admin/clients',
      method: 'GET',
    });
    if (clients.length === 0) {
      process.stdout.write('no clients paired — run `nff-brain pair` to open a window\n');
      return;
    }
    for (const c of clients) {
      process.stdout.write(`${c.id}  ${c.name}\n  origin ${c.origin}\n  paired ${c.createdAt}\n`);
    }
    return;
  }

  const revoke = flagStr(args, 'revoke');
  if (revoke) {
    const { removed } = await admin<{ removed: boolean }>({ path: '/v1/admin/revoke', body: { id: revoke } });
    process.stdout.write(removed ? `revoked ${revoke}\n` : `no client with id ${revoke}\n`);
    return;
  }

  const { code, expiresAt } = await admin<{ code: string; expiresAt: string }>({ path: '/v1/admin/pair-window' });
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  process.stdout.write(
    `PAIRING OPEN for ${minutes}m — enter this code in the extension popup:\n\n` +
      `    ${formatPairingCode(code)}\n\n` +
      `(5 wrong attempts closes the window; re-open with \`nff-brain pair\`)\n`,
  );
}
