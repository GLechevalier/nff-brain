import {
  formatPairingCode,
  isInstanceAlive,
  loadServeConfig,
  mintServerIdentity,
  readInstance,
  saveServeConfig,
  serveConfigPath,
} from '@nff-brain/core';
import { fail, flagStr, parseArgs } from '../util.js';

// `nff-brain pair` drives the RUNNING server over its own admin routes rather
// than editing serve.json underneath it — otherwise a code opened here would
// live in a different process's memory than the one answering /v1/pair.
//
// The exception is --reset, which must work with the server down (that is when
// you most want it). It rewrites the file directly; the server notices via the
// mtime check in ServeState.config() within a second.

interface AdminCall {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

async function admin<T>({ path, method = 'POST', body }: AdminCall): Promise<T> {
  const inst = readInstance();
  if (!inst || !isInstanceAlive(inst)) {
    fail('nff-brain serve is not running — start it first (`nff-brain serve`)');
  }
  const cfg = loadServeConfig();
  if (!cfg) fail(`no ${serveConfigPath()} yet — start \`nff-brain serve\` once to create it`);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.adminToken}`,
        // Every POST carries a JSON content-type, even a bodyless one: the
        // server rejects other types outright to block HTML-form CSRF, and an
        // exemption for empty bodies would be a hole for no benefit.
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    fail(`could not reach the server on port ${inst.port} — is it still running?`);
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok || json.ok !== true) {
    fail(`server refused: ${json.message ?? res.status}`);
  }
  return json as T;
}

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
