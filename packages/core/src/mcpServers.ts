// Registered MCP servers — one flat file, mirroring serveConfig.ts's secret
// discipline (0600, atomic write) since `headers` may carry a bearer token or
// an X-Admin-Data-Secret. Registering a server (this file's writers) is a
// local CLI-only concern, same trust tier as pairing itself: the browser
// extension only ever reads already-registered servers through client-auth
// HTTP routes, and those routes never echo `headers` back.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BRAIN_DIR } from './paths.js';
import { writeFileAtomic } from './store.js';
import type { McpServerConfig } from './mcpClient.js';

export function mcpServersPath(): string {
  return path.join(os.homedir(), BRAIN_DIR, 'mcp-servers.json');
}

function isServerConfig(v: unknown): v is McpServerConfig {
  const s = v as Partial<McpServerConfig>;
  return (
    !!s &&
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.url === 'string' &&
    typeof s.enabled === 'boolean' &&
    (s.headers === undefined || (typeof s.headers === 'object' && s.headers !== null))
  );
}

/** Absent, unreadable or malformed all read as "no servers registered" — never throws. */
export function loadMcpServers(file = mcpServersPath()): McpServerConfig[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isServerConfig);
  } catch {
    return [];
  }
}

/** 0600 on POSIX — see serveConfig.ts's saveServeConfig for the Windows caveat. */
export function saveMcpServers(servers: McpServerConfig[], file = mcpServersPath()): void {
  writeFileAtomic(file, JSON.stringify(servers, null, 2) + '\n', 0o600);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function addMcpServer(
  servers: readonly McpServerConfig[],
  opts: { name: string; url: string; headers?: Record<string, string> },
): { servers: McpServerConfig[]; server: McpServerConfig } {
  const server: McpServerConfig = {
    id: `mcp_${randomBytes(4).toString('hex')}`,
    name: opts.name.slice(0, 80),
    url: opts.url,
    headers: opts.headers,
    enabled: true,
  };
  return { servers: [...servers, server], server };
}

export function removeMcpServer(servers: readonly McpServerConfig[], id: string): McpServerConfig[] {
  return servers.filter((s) => s.id !== id);
}

export function findMcpServer(servers: readonly McpServerConfig[], id: string): McpServerConfig | undefined {
  return servers.find((s) => s.id === id);
}
