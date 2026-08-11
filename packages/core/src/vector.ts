// Vector math + the sidecar's wire codec. BROWSER-SAFE: no node: imports, no
// Buffer, no atob — this module is bundled into the VS Code webview IIFE
// alongside score.ts. Keep it that way (see webviewImports.test.ts).
//
// GOTCHA — embedding similarity is NOT distributed like the lexical scores in
// score.ts. bge/MiniLM-family cosines have a compressed, HIGH baseline: two
// unrelated English sentences sit around 0.6–0.7, genuinely related ones around
// 0.8–0.9. So a raw cosine is NOT comparable to a scoreNode value, and any
// "just average them" fusion lets a 0.68 non-match outrank a real 0.55 lexical
// hit. That is why rank.ts fuses by RANK (RRF), not by score. Do not simplify it.

/** Vectors are stored unit-normalised, so cosine is a plain dot product. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Cosine similarity of two arbitrary (not necessarily normalised) vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    s += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return s / Math.sqrt(na * nb);
}

/** L2-normalise in a fresh array. Returns null for a zero/degenerate vector. */
export function normalise(v: Float32Array | number[]): Float32Array | null {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (!Number.isFinite(x)) return null;
    sum += x * x;
  }
  if (sum <= 0) return null;
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

// ── base64 codec ─────────────────────────────────────────────────────────────
// Hand-rolled because Buffer is node-only and atob/btoa are browser-only, and
// this file has to work in both. Floats are written LITTLE-ENDIAN explicitly —
// DataView defaults to big-endian and the platform default is not portable.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = /* @__PURE__ */ (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

export function encodeVector(v: Float32Array): string {
  const bytes = new Uint8Array(v.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, true);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

/** Inverse of encodeVector. Returns null on malformed input or a dim mismatch. */
export function decodeVector(s: string, dim?: number): Float32Array | null {
  if (typeof s !== 'string') return null;
  let end = s.length;
  while (end > 0 && s[end - 1] === '=') end--;
  const byteLen = Math.floor((end * 3) / 4);
  if (byteLen === 0 || byteLen % 4 !== 0) return null;
  if (dim !== undefined && byteLen / 4 !== dim) return null;
  const bytes = new Uint8Array(byteLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = s.charCodeAt(i);
    const d = code < 128 ? B64_INV[code]! : -1;
    if (d < 0) return null;
    acc = (acc << 6) | d;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 0xff;
    }
  }
  if (o !== byteLen) return null;
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(byteLen / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

// ── retrieval ────────────────────────────────────────────────────────────────

export interface SimHit {
  id: string;
  sim: number;
}

/**
 * Top-k by cosine against a map of unit vectors, best first. Ties keep the
 * map's insertion order, so results are stable across runs.
 */
export function topKBySim(
  query: Float32Array,
  vectors: Map<string, Float32Array>,
  k: number,
): SimHit[] {
  if (k <= 0 || vectors.size === 0) return [];
  const hits: SimHit[] = [];
  for (const [id, v] of vectors) {
    if (v.length !== query.length) continue;
    hits.push({ id, sim: dot(query, v) });
  }
  // Stable: Array.prototype.sort is stable in every engine we target (ES2019+).
  hits.sort((a, b) => b.sim - a.sim);
  return hits.length > k ? hits.slice(0, k) : hits;
}
