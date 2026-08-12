import { describe, expect, it } from 'vitest';
import {
  EXTENSION_ORIGIN_RE,
  PAIRING_ALPHABET,
  RateBuckets,
  formatPairingCode,
  hashToken,
  helloProof,
  isAllowedFetchContext,
  isAllowedHost,
  isAllowedOrigin,
  newPairingCode,
  newToken,
  normalizePairingCode,
  openPairingWindow,
  tokenMatches,
  verifyPairingCode,
} from '../src/index.js';

const PAIRED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('isAllowedHost — gate 3, the DNS-rebinding kill', () => {
  it('accepts exactly the three loopback spellings on the right port', () => {
    for (const h of ['127.0.0.1:7373', 'localhost:7373', '[::1]:7373']) {
      expect(isAllowedHost(h, 7373)).toBe(true);
    }
  });

  it.each([
    ['evil.com', 'a rebound name'],
    ['evil.com:7373', 'a rebound name carrying our port'],
    ['127.0.0.1:7374', 'the wrong port'],
    ['127.0.0.1', 'no port at all'],
    ['127.0.0.1:7373.evil.com', 'our host as a prefix'],
    ['evil.com:7373.', 'a trailing dot'],
    ['', 'empty'],
  ])('rejects %j (%s)', (host) => {
    expect(isAllowedHost(host, 7373)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isAllowedHost(undefined, 7373)).toBe(false);
  });
});

describe('isAllowedOrigin — gate 5, exact match only', () => {
  it('accepts the paired origin', () => {
    expect(isAllowedOrigin(PAIRED, [PAIRED])).toBe(true);
  });

  it.each([
    ['chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', 'a DIFFERENT extension (adversary B)'],
    [`${PAIRED}.evil.com`, 'our origin as a prefix'],
    [`${PAIRED}x`, 'our origin plus a character'],
    ['Chrome-Extension://abcdefghijklmnopabcdefghijklmnop', 'a case variant'],
    ['https://evil.com', 'a web page'],
    ['null', 'the literal null origin'],
    ['', 'empty'],
  ])('rejects %j (%s)', (origin) => {
    expect(isAllowedOrigin(origin, [PAIRED])).toBe(false);
  });

  it('rejects a missing Origin header', () => {
    expect(isAllowedOrigin(undefined, [PAIRED])).toBe(false);
  });

  it('matches only real extension ids', () => {
    expect(EXTENSION_ORIGIN_RE.test(PAIRED)).toBe(true);
    expect(EXTENSION_ORIGIN_RE.test('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(EXTENSION_ORIGIN_RE.test('chrome-extension://short')).toBe(false);
  });
});

describe('isAllowedFetchContext — gate 7', () => {
  it('allows a script-initiated fetch', () => {
    expect(isAllowedFetchContext('cors', 'empty')).toBe(true);
    expect(isAllowedFetchContext(undefined, undefined)).toBe(true);
  });

  it('rejects top-level navigation and subresource probes', () => {
    expect(isAllowedFetchContext('navigate', 'document')).toBe(false);
    expect(isAllowedFetchContext('no-cors', 'image')).toBe(false);
    expect(isAllowedFetchContext('no-cors', 'script')).toBe(false);
  });
});

describe('tokenMatches', () => {
  const token = newToken();
  const stored = hashToken(token);

  it('mints an unpadded 43-char base64url token', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts the right token', () => {
    expect(tokenMatches(token, stored)).toBe(true);
  });

  it.each([
    ['a wrong token', newToken()],
    ['a truncated token', token.slice(0, -1)],
    ['an extended token', `${token}x`],
    ['the empty string', ''],
  ])('rejects %s without throwing on the length mismatch', (_label, presented) => {
    expect(tokenMatches(presented, stored)).toBe(false);
  });

  it('rejects a malformed stored hash rather than throwing', () => {
    expect(tokenMatches(token, 'sha256:nothex')).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
  });
});

describe('helloProof', () => {
  const hash = hashToken(newToken());

  it('is deterministic for a fixed (tokenHash, nonce)', () => {
    expect(helloProof(hash, 'abc123')).toBe(helloProof(hash, 'abc123'));
    expect(helloProof(hash, 'abc123')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when either input changes', () => {
    expect(helloProof(hash, 'abc123')).not.toBe(helloProof(hash, 'abc124'));
    expect(helloProof(hash, 'abc123')).not.toBe(helloProof(hashToken(newToken()), 'abc123'));
  });
});

describe('pairing codes', () => {
  it('excludes the glyphs people mistype', () => {
    for (const bad of ['I', 'L', 'O', 'U']) expect(PAIRING_ALPHABET).not.toContain(bad);
    expect(new Set(PAIRING_ALPHABET).size).toBe(32); // no modulo bias over 256
  });

  it('mints codes drawn only from the alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = newPairingCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(PAIRING_ALPHABET).toContain(ch);
    }
  });

  it('normalizes separators, case and the excluded glyphs', () => {
    expect(normalizePairingCode('k7m-2qx')).toBe('K7M2QX');
    expect(normalizePairingCode('K7M 2QX')).toBe('K7M2QX');
    expect(normalizePairingCode('IL0')).toBe('110');
    expect(normalizePairingCode('O')).toBe('0');
  });

  it('formats for display without changing the wire form', () => {
    expect(formatPairingCode('K7M2QX')).toBe('K7M-2QX');
    expect(normalizePairingCode(formatPairingCode('K7M2QX'))).toBe('K7M2QX');
  });

  it('accepts the right code exactly once', () => {
    const { window, code } = openPairingWindow(1000, 'K7M2QX');
    const first = verifyPairingCode(window, code, 1000);
    expect(first.verdict).toBe('ok');
    // Replaying it must fail — the window is consumed, not merely used.
    expect(verifyPairingCode(first.window, code, 1000).verdict).toBe('closed');
  });

  it('accepts a code the user typed with dashes and lower case', () => {
    const { window } = openPairingWindow(1000, 'K7M2QX');
    expect(verifyPairingCode(window, 'k7m-2qx', 1000).verdict).toBe('ok');
  });

  it('expires', () => {
    const { window, code } = openPairingWindow(1000, 'K7M2QX');
    expect(verifyPairingCode(window, code, 1000 + 5 * 60_000 + 1).verdict).toBe('expired');
  });

  it('closes permanently after five wrong attempts, even if the sixth is right', () => {
    let { window, code } = openPairingWindow(0, 'K7M2QX');
    for (let i = 0; i < 5; i++) {
      const r = verifyPairingCode(window, 'AAAAAA', 0);
      expect(r.verdict).toBe('bad_code');
      window = r.window;
    }
    expect(verifyPairingCode(window, code, 0).verdict).toBe('closed');
  });
});

describe('RateBuckets', () => {
  function clocked() {
    let t = 0;
    const buckets = new RateBuckets(() => t);
    return { buckets, advance: (ms: number) => (t += ms) };
  }

  it('throttles the anon bucket after ten failures', () => {
    const { buckets } = clocked();
    for (let i = 0; i < 9; i++) buckets.fail('anon');
    expect(buckets.throttled('anon')).toBe(false);
    buckets.fail('anon');
    expect(buckets.throttled('anon')).toBe(true);
  });

  it('rolls the window forward', () => {
    const { buckets, advance } = clocked();
    for (let i = 0; i < 10; i++) buckets.fail('anon');
    expect(buckets.throttled('anon')).toBe(true);
    advance(60_001);
    expect(buckets.throttled('anon')).toBe(false);
  });

  it('keeps the paired bucket working when anon is exhausted', () => {
    // THE DoS-ISOLATION ASSERTION. A hostile page can flood 127.0.0.1 all it
    // likes; it must never be able to lock the user's own extension out.
    const { buckets } = clocked();
    for (let i = 0; i < 50; i++) buckets.fail('anon');
    expect(buckets.throttled('anon')).toBe(true);
    expect(buckets.throttled('paired')).toBe(false);
  });

  it('gives the paired bucket a higher ceiling', () => {
    const { buckets } = clocked();
    for (let i = 0; i < 19; i++) buckets.fail('paired');
    expect(buckets.throttled('paired')).toBe(false);
    buckets.fail('paired');
    expect(buckets.throttled('paired')).toBe(true);
  });

  it('forgives a fixed typo', () => {
    const { buckets } = clocked();
    for (let i = 0; i < 10; i++) buckets.fail('paired');
    buckets.succeed('paired');
    expect(buckets.throttled('paired')).toBe(false);
  });

  it('reports a retry-after inside the window', () => {
    const { buckets, advance } = clocked();
    buckets.fail('anon');
    advance(10_000);
    expect(buckets.retryAfterSec('anon')).toBe(50);
  });

  it('applies a global ceiling over all requests', () => {
    const { buckets } = clocked();
    for (let i = 0; i < 240; i++) expect(buckets.overCeiling()).toBe(false);
    expect(buckets.overCeiling()).toBe(true);
  });
});
