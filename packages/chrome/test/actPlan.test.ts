import { describe, expect, it } from 'vitest';
import { dragSamples, keyDescriptor, modifierBits, wheelSteps } from '../src/actPlan.js';

describe('modifierBits', () => {
  it('encodes the CDP bitmask (Alt=1 Ctrl=2 Meta=4 Shift=8)', () => {
    expect(modifierBits(undefined)).toBe(0);
    expect(modifierBits({})).toBe(0);
    expect(modifierBits({ ctrl: true })).toBe(2);
    expect(modifierBits({ shift: true })).toBe(8);
    expect(modifierBits({ ctrl: true, shift: true })).toBe(10);
    expect(modifierBits({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15);
  });
});

describe('keyDescriptor', () => {
  it('maps named navigation/editing keys', () => {
    expect(keyDescriptor('Enter')).toMatchObject({ code: 'Enter', vk: 13, text: '\r' });
    expect(keyDescriptor('Tab')).toMatchObject({ code: 'Tab', vk: 9 });
    expect(keyDescriptor('ArrowDown')).toMatchObject({ code: 'ArrowDown', vk: 40 });
    expect(keyDescriptor('Space')).toMatchObject({ key: ' ', code: 'Space', vk: 32, text: ' ' });
  });
  it('maps single printable characters with a best-effort code', () => {
    expect(keyDescriptor('a')).toMatchObject({ key: 'a', code: 'KeyA', vk: 65, text: 'a' });
    expect(keyDescriptor('Z')).toMatchObject({ code: 'KeyZ', vk: 90 });
    expect(keyDescriptor('5')).toMatchObject({ code: 'Digit5', vk: 53, text: '5' });
  });
  it('rejects multi-character non-named strings', () => {
    expect(keyDescriptor('abc')).toBeNull();
    expect(keyDescriptor('')).toBeNull();
  });
});

describe('wheelSteps', () => {
  const sum = (steps: Array<{ dx: number; dy: number }>) =>
    steps.reduce((a, s) => ({ dx: a.dx + s.dx, dy: a.dy + s.dy }), { dx: 0, dy: 0 });

  it('sums exactly to the requested delta, including rounding-hostile values', () => {
    for (const [dx, dy] of [
      [0, 777],
      [-333, 100],
      [500, -500],
      [1, 0],
      [0, -3],
      [12345, 7],
    ] as const) {
      expect(sum(wheelSteps(dx, dy))).toEqual({ dx, dy });
    }
  });

  it('eases out: the first tick of a large scroll outruns the last', () => {
    const steps = wheelSteps(0, 1200);
    expect(steps.length).toBeGreaterThan(4);
    expect(Math.abs(steps[0]!.dy)).toBeGreaterThan(Math.abs(steps[steps.length - 1]!.dy));
  });

  it('never emits a both-zero step and still delivers tiny nudges', () => {
    const steps = wheelSteps(0, 3);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    for (const s of [...steps, ...wheelSteps(-333, 100)]) {
      expect(s.dx !== 0 || s.dy !== 0).toBe(true);
    }
  });

  it('returns nothing for a zero scroll', () => {
    expect(wheelSteps(0, 0)).toEqual([]);
  });
});

describe('dragSamples', () => {
  it('includes both endpoints and the requested number of steps', () => {
    const pts = dragSamples({ x: 0, y: 0 }, { x: 100, y: 50 }, 4);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 50 });
    expect(pts).toHaveLength(5); // start + 4 samples (last sample == end)
  });
  it('interpolates linearly', () => {
    const pts = dragSamples({ x: 0, y: 0 }, { x: 10, y: 0 }, 2);
    expect(pts[1]).toEqual({ x: 5, y: 0 });
  });
  it('clamps degenerate step counts', () => {
    expect(dragSamples({ x: 0, y: 0 }, { x: 1, y: 1 }, 0).length).toBeGreaterThanOrEqual(2);
  });
});
