// The HTTP client. Every URL it can possibly build points at 127.0.0.1 — the
// manifest's `connect-src 'self' http://127.0.0.1:*` makes Chrome enforce that
// too, and bundlePurity.test.ts asserts no other origin appears in the bundle.

import {
  HOST,
  REQUEST_TIMEOUT_MS,
  isHelloResponse,
  isPairResponse,
  isStatusResponse,
} from './protocol.js';
import type { ClipResponse, HelloResponse, PairResponse, StatusResponse } from './protocol.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** 401/403 mean the pairing is dead — retrying forever is pointless. */
  get rejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function url(port: number, path: string): string {
  return `http://${HOST}:${port}${path}`;
}

async function call(port: number, path: string, init: RequestInit & { token?: string } = {}): Promise<unknown> {
  const { token, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url(port, path), {
      ...rest,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...rest.headers,
      },
      // A hung fetch in a service worker is a bad failure mode: it keeps the
      // worker alive burning nothing useful and it makes the popup hang.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new HttpError(0, 'network', name === 'TimeoutError' ? 'the brain did not answer in time' : 'no brain listening');
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new HttpError(res.status, body.error ?? String(res.status), body.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function hello(port: number, params?: { nonce: string; clientId: string }): Promise<HelloResponse> {
  const qs = params ? `?nonce=${encodeURIComponent(params.nonce)}&client=${encodeURIComponent(params.clientId)}` : '';
  const body = await call(port, `/v1/hello${qs}`);
  if (!isHelloResponse(body)) throw new HttpError(0, 'protocol', 'that port is not an nff-brain server');
  return body;
}

export async function pair(port: number, code: string): Promise<PairResponse> {
  const body = await call(port, '/v1/pair', {
    method: 'POST',
    body: JSON.stringify({ code, client: { name: 'Chrome extension' } }),
  });
  if (!isPairResponse(body)) throw new HttpError(0, 'protocol', 'unexpected pairing response');
  return body;
}

export async function status(port: number, token: string): Promise<StatusResponse> {
  const body = await call(port, '/v1/status', { token });
  // A malformed body is a DISCONNECT, not a connection reporting zero nodes:
  // "0 nodes" is a real and alarming state and must not be manufacturable by a
  // truncated response.
  if (!isStatusResponse(body)) throw new HttpError(0, 'protocol', 'unexpected status response');
  return body;
}

export interface ClipPayload {
  kind: 'selection' | 'link' | 'page' | 'note';
  text: string;
  url?: string;
  title?: string;
  capturedAt: string;
}

export async function postClip(port: number, token: string, clip: ClipPayload): Promise<ClipResponse> {
  return (await call(port, '/v1/clip', { method: 'POST', token, body: JSON.stringify(clip) })) as ClipResponse;
}

/**
 * Confirm a port is OUR server before sending it a bearer token.
 *
 * The extension walks a small port range, so without this a hostile local
 * process squatting a neighbouring port would harvest the token on the first
 * request. The server proves it holds our token's hash by HMACing a nonce with
 * it; we recompute the same value from the token we already have.
 */
export async function verifyProof(port: number, token: string, clientId: string): Promise<boolean> {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  let res: HelloResponse;
  try {
    res = await hello(port, { nonce, clientId });
  } catch {
    return false;
  }
  if (!res.proof) return false;
  return res.proof === (await helloProof(token, nonce));
}

/** HMAC-SHA256(key = SHA-256(token), "nff-brain-hello-v1:" + nonce), hex. */
async function helloProof(token: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(token));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`nff-brain-hello-v1:${nonce}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
