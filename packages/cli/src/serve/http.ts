// Response helpers for the serve pipeline. node:http only — the published CLI
// is a zero-runtime-dependency tarball and an HTTP framework would end that.

import type { IncomingMessage, ServerResponse } from 'node:http';

export type ErrorCode =
  | 'bad_host'
  | 'forbidden_origin'
  | 'forbidden_context'
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'rate_limited'
  | 'not_found'
  | 'method_not_allowed'
  | 'bad_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'queue_full'
  | 'pairing_closed'
  | 'bad_code'
  | 'run_active'
  | 'no_client'
  | 'unknown_client'
  | 'ambiguous_client'
  | 'mcp_error'
  | 'chat_error'
  | 'act_error';

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // A brain listing is never cacheable, and no-store also keeps tokens out of
  // any intermediary that might otherwise hold a /pair response.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  error: ErrorCode,
  message: string,
  extra: Record<string, string> = {},
): void {
  sendJson(res, status, { ok: false, error, message }, extra);
}

export interface CorsOptions {
  /** Echo the exact requesting origin. NEVER '*' — that would let any page read
   *  the responses, which is the entire attack this server exists to prevent. */
  origin: string;
  /** Mirror an Access-Control-Request-Private-Network preflight. */
  privateNetwork?: boolean;
}

export function corsHeaders(opts: CorsOptions): Record<string, string> {
  const h: Record<string, string> = {
    'access-control-allow-origin': opts.origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    // Without Vary a shared cache could hand one origin's response to another.
    vary: 'Origin',
  };
  if (opts.privateNetwork) h['access-control-allow-private-network'] = 'true';
  return h;
}

export class BodyError extends Error {
  constructor(public readonly code: 'payload_too_large' | 'bad_request') {
    super(code);
  }
}

/**
 * Read a JSON body with a hard byte cap, destroying the socket the moment the
 * cap is passed rather than buffering the rest politely.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: BodyError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new BodyError('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => fail(new BodyError('bad_request')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError('bad_request'));
      }
    });
  });
}

/** First value of a possibly-repeated header, lower-cased comparisons welcome. */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Bearer token from Authorization. Query-string tokens are never accepted. */
export function bearer(req: IncomingMessage): string | undefined {
  const raw = header(req, 'authorization');
  if (!raw) return undefined;
  const m = /^Bearer (.+)$/i.exec(raw.trim());
  return m ? m[1] : undefined;
}
