import { describe, expect, it } from 'vitest';
import { cosine, decodeVector, dot, encodeVector, normalise, topKBySim } from '../src/vector.js';

function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

describe('encodeVector / decodeVector', () => {
  it('round-trips exactly, including negatives and zero', () => {
    const v = vec(0, 1, -1, 0.5, -0.25, 1e-8, -1e-8, 3.5);
    const back = decodeVector(encodeVector(v));
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(v));
  });

  it('round-trips a realistic 384-dim unit vector', () => {
    const raw = Array.from({ length: 384 }, (_, i) => Math.sin(i) * (i % 7) - 0.3);
    const v = normalise(raw)!;
    const back = decodeVector(encodeVector(v), 384);
    expect(back).not.toBeNull();
    expect(back!.length).toBe(384);
    for (let i = 0; i < 384; i++) expect(back![i]).toBe(v[i]);
    // A 384-float payload is 1536 bytes ⇒ exactly 2048 base64 chars, no padding.
    expect(encodeVector(v)).toHaveLength(2048);
  });

  it('writes LITTLE-endian floats (platform default is not portable)', () => {
    // 1.0 as IEEE-754 float32 is 0x3F800000; little-endian bytes are 00 00 80 3F.
    const s = encodeVector(vec(1));
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    const round = decodeVector(s)!;
    view.setFloat32(0, round[0]!, true);
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(s).toBe('AACAPw==');
  });

  it('rejects malformed input and dim mismatches', () => {
    expect(decodeVector('')).toBeNull();
    expect(decodeVector('!!!!')).toBeNull();
    expect(decodeVector('AAA=')).toBeNull(); // 2 bytes — not a whole float
    expect(decodeVector(encodeVector(vec(1, 2, 3)), 4)).toBeNull();
    expect(decodeVector(encodeVector(vec(1, 2, 3)), 3)).not.toBeNull();
  });
});

describe('normalise', () => {
  it('produces a unit vector', () => {
    const u = normalise([3, 4])!;
    expect(u[0]).toBeCloseTo(0.6, 6);
    expect(u[1]).toBeCloseTo(0.8, 6);
    expect(dot(u, u)).toBeCloseTo(1, 6);
  });

  it('returns null (not NaN) for a zero or non-finite vector', () => {
    expect(normalise([0, 0, 0])).toBeNull();
    expect(normalise([Number.NaN, 1])).toBeNull();
    expect(normalise([Number.POSITIVE_INFINITY, 1])).toBeNull();
  });
});

describe('cosine', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosine(vec(1, 0), vec(2, 0))).toBeCloseTo(1, 6);
    expect(cosine(vec(1, 0), vec(0, 5))).toBeCloseTo(0, 6);
    expect(cosine(vec(1, 0), vec(-3, 0))).toBeCloseTo(-1, 6);
  });

  it('returns 0 rather than NaN against a zero vector', () => {
    expect(cosine(vec(1, 0), vec(0, 0))).toBe(0);
  });

  it('agrees with dot for unit vectors (the storage invariant)', () => {
    const a = normalise([1, 2, 3])!;
    const b = normalise([-3, 1, 0.5])!;
    expect(dot(a, b)).toBeCloseTo(cosine(a, b), 6);
  });
});

describe('topKBySim', () => {
  const vectors = new Map([
    ['a', normalise([1, 0])!],
    ['b', normalise([0.9, 0.1])!],
    ['c', normalise([0, 1])!],
  ]);

  it('returns the k best, most-similar first', () => {
    const hits = topKBySim(normalise([1, 0])!, vectors, 2);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(hits[0]!.sim).toBeGreaterThan(hits[1]!.sim);
  });

  it('keeps insertion order on ties, so results are stable', () => {
    const tied = new Map([
      ['x', normalise([1, 0])!],
      ['y', normalise([1, 0])!],
    ]);
    expect(topKBySim(normalise([1, 0])!, tied, 2).map((h) => h.id)).toEqual(['x', 'y']);
  });

  it('skips vectors of a different dimension instead of throwing', () => {
    const mixed = new Map([
      ['ok', normalise([1, 0])!],
      ['wrong', normalise([1, 0, 0])!],
    ]);
    expect(topKBySim(normalise([1, 0])!, mixed, 5).map((h) => h.id)).toEqual(['ok']);
  });

  it('handles empty input and k <= 0', () => {
    expect(topKBySim(vec(1, 0), new Map(), 5)).toEqual([]);
    expect(topKBySim(vec(1, 0), vectors, 0)).toEqual([]);
  });
});
