// Shared admin-route client for CLI commands (`pair`, `agent`, …): drives the
// RUNNING server over loopback with the adminToken from serve.json rather than
// editing state files underneath it — the process answering HTTP must be the
// one that owns the in-memory state.

import { isInstanceAlive, loadServeConfig, readInstance, serveConfigPath } from '@nff-brain/core';
import { fail } from '../util.js';

export interface AdminCall {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}

export async function admin<T>({ path, method = 'POST', body, timeoutMs = 5_000 }: AdminCall): Promise<T> {
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
      signal: AbortSignal.timeout(timeoutMs),
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
