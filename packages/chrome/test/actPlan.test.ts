import { describe, expect, it } from 'vitest';
import { dragSamples, keyDescriptor, modifierBits } from '../src/actPlan.js';

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
