// `nff-brain mcp` — register the HTTP MCP servers the web agent (and any
// future MCP-calling feature) can reach. Registering a server is a local
// CLI-only concern, same trust tier as pairing itself: the browser extension
// only ever reads already-registered servers through client-auth HTTP routes,
// and those never echo `headers` (where a bearer token or an
// X-Admin-Data-Secret lives) back.

import { addMcpServer, loadMcpServers, pingMcpServer, removeMcpServer, saveMcpServers } from '@nff-brain/core';
import { fail, flagStr, parseArgs } from '../util.js';

function parseHeader(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf(':');
  if (i < 0) fail(`--header must look like "Key: value", got "${raw}"`);
  return { [raw.slice(0, i).trim()]: raw.slice(i + 1).trim() };
}

export async function cmdMcp(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);

  if (sub === 'add') {
    const [name, url] = args.positional;
    if (!name || !url) fail('usage: nff-brain mcp add <name> <url> [--header "Key: value"]');
    if (!/^https?:\/\//i.test(url)) fail(`"${url}" does not look like an http(s) URL`);
    const headers = parseHeader(flagStr(args, 'header'));
    const servers = loadMcpServers();
    const { servers: next, server } = addMcpServer(servers, { name, url, headers });
    saveMcpServers(next);
    process.stdout.write(`registered ${server.id}  ${server.name}  ${server.url}\n`);
    process.stdout.write(`run \`nff-brain mcp test ${server.id}\` to confirm it answers tools/list\n`);
    return;
  }

  if (sub === 'list') {
    const servers = loadMcpServers();
    if (servers.length === 0) {
      process.stdout.write('no MCP servers registered — run `nff-brain mcp add <name> <url>`\n');
      return;
    }
    for (const s of servers) {
      process.stdout.write(`${s.id}  ${s.enabled ? '' : '(disabled) '}${s.name}\n  ${s.url}\n`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = args.positional[0];
    if (!id) fail('usage: nff-brain mcp remove <id>');
    const servers = loadMcpServers();
    const next = removeMcpServer(servers, id);
    if (next.length === servers.length) {
      process.stdout.write(`no server with id ${id}\n`);
      return;
    }
    saveMcpServers(next);
    process.stdout.write(`removed ${id}\n`);
    return;
  }

  if (sub === 'test') {
    const id = args.positional[0];
    if (!id) fail('usage: nff-brain mcp test <id>');
    const server = loadMcpServers().find((s) => s.id === id);
    if (!server) fail(`no server with id ${id} — run \`nff-brain mcp list\``);
    const result = await pingMcpServer(server);
    // process.exitCode alone is a no-op here — index.ts's main() always calls
    // flushExit(0) on a resolved promise regardless of exitCode, so a real
    // failure exit must come from fail() (console.error + process.exit(1)).
    if (!result.ok) fail(`${server.name}: FAILED — ${result.error}`);
    process.stdout.write(`${server.name}: ok, ${result.toolCount} tool(s)\n`);
    for (const t of result.tools) {
      process.stdout.write(`  ${t.name}${t.description ? ` — ${t.description}` : ''}\n`);
    }
    return;
  }

  fail('usage: nff-brain mcp <add|list|remove|test> ...');
}
