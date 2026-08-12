// On-disk state for `nff-brain serve`, split across TWO files because they have
// opposite write frequencies and opposite secrecy:
//
//   ~/.nff-brain/serve.json           secret, rarely written, mode 0600
//   ~/.nff-brain/serve-instance.json  not secret, rewritten on every start/stop
//
// Keeping them apart means the file holding bearer tokens is not rewritten (and
// its permissions re-derived) every time the server restarts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BRAIN_DIR } from './paths.js';
import { writeFileAtomic } from './store.js';
import { hashToken, newToken } from './serveAuth.js';

/** Wire-protocol version. Bump only on a breaking change to the /v1 shapes. */
export const SERVE_PROTOCOL = 1;

/**
 * Default port, with a small probe range above it.
 *
 * 7373 sits below every default ephemeral range (Linux 32768–60999, Windows and
 * macOS 49152–65535), so the OS will never hand it to an outbound socket and
 * steal it, and it is clear of the dense dev-port clusters (3000/4200/5000/5173/
 * 8000/8080/9000/9229) plus 1234, 6006, 7860, 11434 and 27017.
 *
 * The range is 5 and not 1 so a foreign squatter, a second workspace or a socket
 * in TIME_WAIT does not wedge the extension — and not 50, because every extra
 * port is one more free fingerprinting probe for a hostile page and one more
 * round trip on extension cold start.
 */
export const DEFAULT_SERVE_PORT = 7373;
export const SERVE_PORT_PROBE_COUNT = 5;

export type CaptureTarget = 'global' | 'project';

export interface ServeClient {
  id: string;
  name: string;
  /** Pinned at pair time. Every later request must match it EXACTLY. */
  origin: string;
  tokenHash: string;
  createdAt: string;
}

export interface ServeConfig {
  version: 1;
  serverId: string;
  /** CLI ⇄ server admin routes only. Never reachable from a browser. */
  adminToken: string;
  clients: ServeClient[];
  capture: { defaultTarget: CaptureTarget };
}

export interface ServeInstance {
  version: 1;
  pid: number;
  port: number;
  serverId: string;
  workspaceRoot: string;
  startedAt: string;
  cliVersion: string;
}

export function serveConfigPath(): string {
  return path.join(os.homedir(), BRAIN_DIR, 'serve.json');
}

export function serveInstancePath(): string {
  return path.join(os.homedir(), BRAIN_DIR, 'serve-instance.json');
}

// ── serve.json ───────────────────────────────────────────────────────────────

export function mintServerIdentity(): ServeConfig {
  return {
    version: 1,
    serverId: `srv_${randomBytes(8).toString('hex')}`,
    adminToken: newToken(),
    clients: [],
    capture: { defaultTarget: 'global' },
  };
}

/** Returns null when absent or unreadable — a corrupt file reads as "unpaired". */
export function loadServeConfig(file = serveConfigPath()): ServeConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServeConfig>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.serverId !== 'string' || typeof parsed.adminToken !== 'string') return null;
    return {
      version: 1,
      serverId: parsed.serverId,
      adminToken: parsed.adminToken,
      clients: Array.isArray(parsed.clients) ? parsed.clients.filter(isClient) : [],
      capture: { defaultTarget: parsed.capture?.defaultTarget === 'project' ? 'project' : 'global' },
    };
  } catch {
    return null;
  }
}

function isClient(c: unknown): c is ServeClient {
  const v = c as Partial<ServeClient>;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.tokenHash === 'string'
  );
}

/**
 * 0600 on POSIX.
 *
 * On Windows fs.chmod only toggles the read-only bit and cannot restrict other
 * users. What IS true there is that %USERPROFILE%\.nff-brain inherits the profile
 * ACL, so other standard users cannot read it — but SYSTEM and Administrators
 * can. We deliberately do not shell out to icacls: that is a whole new failure
 * mode for no gain against an attacker who is already Administrator.
 */
export function saveServeConfig(cfg: ServeConfig, file = serveConfigPath()): void {
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', 0o600);
  if (process.platform !== 'win32') {
    // The open(2) mode is masked by umask, and the target may already have
    // existed as 0644 — chmod is what actually guarantees the result.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort — doctor reports the real mode */
    }
  }
}

/** POSIX mode bits of serve.json, or null when absent / on Windows. */
export function serveConfigMode(file = serveConfigPath()): number | null {
  if (process.platform === 'win32') return null;
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

// ── clients ──────────────────────────────────────────────────────────────────

/**
 * Mint a client. The raw token is returned ONCE and never stored — serve.json
 * only ever holds its sha256.
 */
export function addClient(
  cfg: ServeConfig,
  opts: { name: string; origin: string; now?: Date },
): { client: ServeClient; token: string } {
  const token = newToken();
  const client: ServeClient = {
    id: `cl_${randomBytes(4).toString('hex')}`,
    name: opts.name.slice(0, 80),
    origin: opts.origin,
    tokenHash: hashToken(token),
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  // Re-pairing from the same origin replaces rather than accumulates, so the
  // clients list cannot grow without bound across dev reloads.
  cfg.clients = cfg.clients.filter((c) => c.origin !== opts.origin);
  cfg.clients.push(client);
  return { client, token };
}

export function removeClient(cfg: ServeConfig, id: string): boolean {
  const before = cfg.clients.length;
  cfg.clients = cfg.clients.filter((c) => c.id !== id);
  return cfg.clients.length < before;
}

export function findClientByOrigin(cfg: ServeConfig, origin: string): ServeClient | undefined {
  return cfg.clients.find((c) => c.origin === origin);
}

export function findClientById(cfg: ServeConfig, id: string): ServeClient | undefined {
  return cfg.clients.find((c) => c.id === id);
}

// ── serve-instance.json ──────────────────────────────────────────────────────

export function readInstance(file = serveInstancePath()): ServeInstance | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServeInstance>;
    if (typeof parsed?.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return parsed as ServeInstance;
  } catch {
    return null;
  }
}

export function writeInstance(inst: ServeInstance, file = serveInstancePath()): void {
  try {
    writeFileAtomic(file, JSON.stringify(inst, null, 2) + '\n');
  } catch {
    /* advisory only — never take the server down over it */
  }
}

export function clearInstance(file = serveInstancePath()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

/** Whether the recorded pid is still running. A false here means a stale record. */
export function isInstanceAlive(inst: ServeInstance | null): boolean {
  if (!inst) return false;
  try {
    process.kill(inst.pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
