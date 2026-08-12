// Security predicates for `nff-brain serve`. Everything here is pure (or as
// close as node:crypto allows) and synchronous, so the whole threat model is
// unit-testable without opening a socket — see test/serveAuth.test.ts.
//
// THREAT MODEL, in the order the gates run:
//   A. JS on any web page can fetch 127.0.0.1. It cannot forge Origin or Host,
//      and it cannot set Authorization.
//   B. Any OTHER installed Chrome extension can fetch from its own service
//      worker with its own chrome-extension:// Origin. This is the underrated
//      one, and it is why pairing pins an exact origin.
//   C. DNS rebinding: http://evil.com re-resolves to 127.0.0.1, so the browser
//      treats it as same-origin and CORS does not apply. Only the Host header
//      still gives it away.
//   D. Another local process running as the same OS user. Out of scope — it can
//      read serve.json outright.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Chrome extension ids are exactly 32 characters drawn from a–p. */
export const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

const HELLO_CONTEXT = 'nff-brain-hello-v1:';

// ── tokens ───────────────────────────────────────────────────────────────────

/** 32 random bytes, base64url, unpadded (43 chars). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The only form ever written to disk. */
export function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

/**
 * Constant-time token check.
 *
 * timingSafeEqual throws on a length mismatch, and guarding it with a length
 * comparison would leak the token's length. Comparing DIGESTS sidesteps both:
 * they are always 32 bytes, whatever the input.
 */
export function tokenMatches(presented: string, stored: string): boolean {
  const hex = stored.startsWith('sha256:') ? stored.slice(7) : stored;
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = Buffer.from(hex, 'hex');
  return b.length === 32 && timingSafeEqual(a, b);
}

/**
 * Proof that whoever answers a port already knows the client's token, WITHOUT
 * the client having sent it. The extension walks a small port range, so without
 * this a hostile local process could squat a neighbouring port and harvest the
 * bearer token from the first request.
 */
export function helloProof(storedTokenHash: string, nonce: string): string {
  const hex = storedTokenHash.startsWith('sha256:') ? storedTokenHash.slice(7) : storedTokenHash;
  return createHmac('sha256', Buffer.from(hex, 'hex')).update(HELLO_CONTEXT + nonce, 'utf8').digest('hex');
}

// ── header gates ─────────────────────────────────────────────────────────────

/**
 * Gate 3 — the DNS-rebinding kill. A rebound page reaches us as same-origin
 * (so gate 5 never fires), but its Host header still says evil.com.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * Gate 5 — exact match only, never a prefix or suffix test. `chrome-extension://
 * <paired>.evil.com` and `chrome-extension://<paired>x` must both fail, and so
 * must a DIFFERENT extension's origin (adversary B).
 */
export function isAllowedOrigin(origin: string | undefined, allowed: Iterable<string>): boolean {
  if (!origin) return false;
  for (const a of allowed) if (a === origin) return true;
  return false;
}

/**
 * Gate 7 — reject anything that is not a script-initiated fetch. Sec-Fetch-Site
 * is deliberately NOT consulted: its value from an extension service worker is
 * not reliably specified, and gating on it would break the extension.
 */
export function isAllowedFetchContext(mode: string | undefined, dest: string | undefined): boolean {
  if (mode === 'navigate') return false;
  if (dest !== undefined && dest !== 'empty') return false;
  return true;
}

// ── pairing codes ────────────────────────────────────────────────────────────

/** Crockford-ish base32 minus the glyphs people mistype: I, L, O, U. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export function newPairingCode(): string {
  // Rejection-free because 256 % 32 === 0 — no modulo bias to worry about.
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  return out;
}

/** Display form: KM7-2QX. Only ever for humans; the wire takes either. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Strip separators, upper-case, and fold the glyphs the alphabet excludes. */
export function normalizePairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0');
}

export interface PairingWindow {
  salt: string;
  codeHash: string;
  expiresAtMs: number;
  attemptsLeft: number;
  consumed: boolean;
}

export type PairingVerdict = 'ok' | 'bad_code' | 'expired' | 'closed';

export function openPairingWindow(nowMs: number, code = newPairingCode(), ttlMs = PAIRING_TTL_MS): {
  window: PairingWindow;
  code: string;
} {
  const salt = randomBytes(16).toString('hex');
  return {
    code,
    window: {
      salt,
      codeHash: createHash('sha256').update(salt + code, 'utf8').digest('hex'),
      expiresAtMs: nowMs + ttlMs,
      attemptsLeft: PAIRING_MAX_ATTEMPTS,
      consumed: false,
    },
  };
}

/**
 * Verify one attempt. Returns the NEXT window state alongside the verdict, so
 * the caller cannot forget to persist a decremented attempt counter.
 *
 * A wrong code burns an attempt; five wrong codes close the window for good
 * (`nff-brain pair` re-opens it). That hard close is a stronger guarantee than
 * any rate limit, which is why the 32^6 ≈ 1.07e9 search space is comfortable.
 */
export function verifyPairingCode(
  window: PairingWindow,
  presented: string,
  nowMs: number,
): { verdict: PairingVerdict; window: PairingWindow } {
  if (window.consumed || window.attemptsLeft <= 0) return { verdict: 'closed', window };
  if (nowMs > window.expiresAtMs) return { verdict: 'expired', window };

  const candidate = createHash('sha256')
    .update(window.salt + normalizePairingCode(presented), 'utf8')
    .digest();
  const expected = Buffer.from(window.codeHash, 'hex');
  if (expected.length === 32 && timingSafeEqual(candidate, expected)) {
    return { verdict: 'ok', window: { ...window, consumed: true } };
  }
  return { verdict: 'bad_code', window: { ...window, attemptsLeft: window.attemptsLeft - 1 } };
}

// ── rate limiting ────────────────────────────────────────────────────────────

export type BucketName = 'anon' | 'paired';

const LIMITS: Record<BucketName, number> = { anon: 10, paired: 20 };
const WINDOW_MS = 60_000;
const GLOBAL_CEILING = 240;

/**
 * TWO INDEPENDENT BUCKETS, and this is the whole point of the class.
 *
 * A single shared bucket lets any web page flood 127.0.0.1 with bad tokens and
 * lock the user's own extension out — a trivial local denial of service. Splitting
 * anonymous traffic from traffic on a paired origin makes that impossible: the
 * page can only ever exhaust the bucket it is already in.
 */
export class RateBuckets {
  private readonly failures: Record<BucketName, number[]> = { anon: [], paired: [] };
  private requests: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Record an auth failure against a bucket. */
  fail(bucket: BucketName): void {
    const t = this.now();
    this.failures[bucket].push(t);
    this.prune(bucket, t);
  }

  /** Clear a bucket's history after a success, so a fixed typo costs nothing. */
  succeed(bucket: BucketName): void {
    this.failures[bucket] = [];
  }

  throttled(bucket: BucketName): boolean {
    this.prune(bucket, this.now());
    return this.failures[bucket].length >= LIMITS[bucket];
  }

  /** Global ceiling over ALL requests, purely to bound CPU. */
  overCeiling(): boolean {
    const t = this.now();
    this.requests.push(t);
    this.requests = this.requests.filter((x) => t - x < WINDOW_MS);
    return this.requests.length > GLOBAL_CEILING;
  }

  retryAfterSec(bucket: BucketName): number {
    const oldest = this.failures[bucket][0];
    if (oldest === undefined) return 1;
    return Math.max(1, Math.ceil((WINDOW_MS - (this.now() - oldest)) / 1000));
  }

  private prune(bucket: BucketName, t: number): void {
    this.failures[bucket] = this.failures[bucket].filter((x) => t - x < WINDOW_MS);
  }
}
