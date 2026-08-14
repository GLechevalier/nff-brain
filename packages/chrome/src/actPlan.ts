// Pure planners for the CDP action engine: the bits of executeVerb that are
// arithmetic and lookup tables rather than chrome.debugger calls, split out so
// they can be unit-tested without a browser (the engine itself, like the rest
// of the chrome/fetch-touching modules, stays pure-half-only per the repo's
// bundlePurity convention). No chrome.*, no node:*, no module-level state.

import type { Modifiers } from '@nff-brain/core/browserVerbs';

/** CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifierBits(m: Modifiers | undefined): number {
  if (!m) return 0;
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

export interface KeyDescriptor {
  /** DOM key value, e.g. "Enter", "a", "ArrowDown". */
  key: string;
  /** Physical code, e.g. "Enter", "KeyA", "Digit1", "ArrowDown". */
  code: string;
  /** windowsVirtualKeyCode for CDP. */
  vk: number;
  /** Text to emit on keyDown for a character-producing key. */
  text?: string;
}

const NAMED: Record<string, KeyDescriptor> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

/**
 * Map a key (a NamedKey or a single printable character) to CDP descriptor.
 * Returns null for anything unmappable. US layout — the physical `code` is a
 * best-effort guess for letters/digits, which is all CDP needs to drive the
 * common shortcuts and navigation keys.
 */
export function keyDescriptor(key: string): KeyDescriptor | null {
  if (Object.prototype.hasOwnProperty.call(NAMED, key)) return NAMED[key]!;
  if ([...key].length !== 1) return null;
  const ch = key;
  const upper = ch.toUpperCase();
  let code = '';
  if (upper >= 'A' && upper <= 'Z') code = 'Key' + upper;
  else if (ch >= '0' && ch <= '9') code = 'Digit' + ch;
  const vk = upper.charCodeAt(0);
  return { key: ch, code, vk, text: ch };
}

export interface WheelStep {
  dx: number;
  dy: number;
}

/**
 * Split a total wheel delta into eased per-tick deltas so an agent scroll
 * glides like a human flick instead of teleporting. Ease-out cubic
 * (f(t) = 1 − (1−t)³) — fast start, decelerating tail; step count scales
 * with magnitude, clamped 4..16. Cumulative rounding — step i carries
 * round(total·f(i/n)) − round(total·f((i−1)/n)) — so the steps always sum
 * EXACTLY to (dx, dy). Steps where both axes round to 0 are dropped.
 */
export function wheelSteps(dx: number, dy: number): WheelStep[] {
  const mag = Math.max(Math.abs(dx), Math.abs(dy));
  if (mag === 0) return [];
  const n = Math.max(4, Math.min(16, Math.round(mag / 80)));
  const ease = (t: number) => 1 - (1 - t) ** 3;
  const steps: WheelStep[] = [];
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= n; i++) {
    const f = ease(i / n);
    const cx = Math.round(dx * f);
    const cy = Math.round(dy * f);
    const sx = cx - sentX;
    const sy = cy - sentY;
    sentX = cx;
    sentY = cy;
    if (sx !== 0 || sy !== 0) steps.push({ dx: sx, dy: sy });
  }
  return steps;
}

/**
 * Interpolate a drag path from → to as `steps` intermediate samples PLUS both
 * endpoints, so a slider/DnD gets realistic movement rather than a teleport.
 */
export function dragSamples(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
): Array<{ x: number; y: number }> {
  const n = Math.max(1, Math.min(100, Math.round(steps)));
  const pts: Array<{ x: number; y: number }> = [{ x: from.x, y: from.y }];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return pts;
}
