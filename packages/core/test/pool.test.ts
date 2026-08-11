import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/index.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapPool', () => {
  it('returns results in INPUT order, not completion order', async () => {
    // Item 0 is slowest, so completion order is the reverse of input order.
    const items = [30, 20, 10, 0];
    const out = await mapPool(items, 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out.map((r) => r.value)).toEqual([30, 20, 10, 0]);
    expect(out.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });

  it('a rejecting item does not abort the run', async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(out.map((r) => r.value)).toEqual([10, undefined, 30, 40]);
    expect((out[1].error as Error).message).toBe('boom');
    // Everything else still ran.
    expect(out.filter((r) => r.value !== undefined)).toHaveLength(3);
  });

  it('reports progress in completion order with a running count', async () => {
    const seen: Array<[number, number]> = [];
    await mapPool([0, 0, 0], 1, async () => undefined, (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('a throwing progress callback cannot fail the run', async () => {
    const out = await mapPool([1, 2], 2, async (n) => n, () => {
      throw new Error('bad progress bar');
    });
    expect(out.map((r) => r.value)).toEqual([1, 2]);
  });

  it('handles an empty list and clamps a nonsense limit', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    const out = await mapPool([1, 2], 0, async (n) => n);
    expect(out.map((r) => r.value)).toEqual([1, 2]);
  });
});
