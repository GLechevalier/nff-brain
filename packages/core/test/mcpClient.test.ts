import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callMcpTool, listMcpTools, pingMcpServer } from '../src/index.js';
import type { McpServerConfig } from '../src/index.js';

// A minimal stand-in for a real MCP server — enough to exercise the client's
// two supported response modes (plain JSON, and a single-frame SSE reply)
// without needing @modelcontextprotocol/sdk as a test dependency.
type Handler = (body: { method: string; params: unknown }) => { status?: number; contentType?: string; body: string };

function startServer(handler: Handler): Promise<{ server: http.Server; server_config: McpServerConfig }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params: unknown };
        const out = handler(rpc);
        res.writeHead(out.status ?? 200, { 'content-type': out.contentType ?? 'application/json' });
        res.end(out.body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        server_config: { id: 'srv_1', name: 'test', url: `http://127.0.0.1:${port}/mcp`, enabled: true },
      });
    });
  });
}

describe('mcpClient', () => {
  let server: http.Server;
  let config: McpServerConfig;

  afterEach(() => {
    server?.close();
  });

  it('listMcpTools parses a plain JSON tools/list response', async () => {
    ({ server, server_config: config } = await startServer(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'crm_create_contact', description: 'Create a contact', inputSchema: { type: 'object' } }] },
      }),
    })));
    const tools = await listMcpTools(config);
    expect(tools).toEqual([{ name: 'crm_create_contact', description: 'Create a contact', inputSchema: { type: 'object' } }]);
  });

  it('listMcpTools parses a single-frame text/event-stream reply — the stateless-server case', async () => {
    ({ server, server_config: config } = await startServer(() => ({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })}\n\n`,
    })));
    await expect(listMcpTools(config)).resolves.toEqual([]);
  });

  it('sends per-server headers (where a bearer token or X-Admin-Data-Secret lives)', async () => {
    let seenAuth: string | undefined;
    ({ server, server_config: config } = await startServer(() => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) })));
    config.headers = { Authorization: 'Bearer secret' };
    server.on('request', (req) => {
      seenAuth = req.headers.authorization;
    });
    await listMcpTools(config);
    expect(seenAuth).toBe('Bearer secret');
  });

  it('callMcpTool surfaces a tool-level isError as ok:false with the text content as the error', async () => {
    ({ server, server_config: config } = await startServer(() => ({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: 'missing required field' }] },
      }),
    })));
    const result = await callMcpTool(config, 'crm_create_contact', {});
    expect(result).toEqual({ ok: false, error: 'missing required field' });
  });

  it('callMcpTool returns ok:true with the content on success', async () => {
    ({ server, server_config: config } = await startServer(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'created' }] } }),
    })));
    const result = await callMcpTool(config, 'crm_create_contact', { name: 'Ada' });
    expect(result).toEqual({ ok: true, content: [{ type: 'text', text: 'created' }] });
  });

  it('propagates a JSON-RPC error as a thrown-and-caught message, never a crash', async () => {
    ({ server, server_config: config } = await startServer(() => ({
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool' } }),
    })));
    const result = await callMcpTool(config, 'nonexistent', {});
    expect(result).toEqual({ ok: false, error: 'unknown tool' });
  });

  it('pingMcpServer never throws, even against an unreachable server', async () => {
    const dead: McpServerConfig = { id: 'srv_dead', name: 'dead', url: 'http://127.0.0.1:1/mcp', enabled: true };
    const result = await pingMcpServer(dead);
    expect(result.ok).toBe(false);
  });
});
