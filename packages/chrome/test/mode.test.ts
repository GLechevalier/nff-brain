import { describe, expect, it } from 'vitest';
import { deriveBrainMode } from '../src/mode.js';

// The full 12-case matrix (3 prefs × 2 pairing × 2 provider). The invariants
// worth reading out of it: pref null reproduces the legacy rule byte-for-byte
// (pairing always wins), and a pref for an unconfigured backend degrades to
// the other one instead of dead-ending — a saved key or a live pairing is
// never resolved into 'unconfigured'.
describe('deriveBrainMode', () => {
  const cases: Array<['paired' | 'byok' | null, boolean, boolean, string]> = [
    // pref, pairingStored, providerConfigured → expected
    [null, false, false, 'unconfigured'],
    [null, false, true, 'byok'],
    [null, true, false, 'paired'],
    [null, true, true, 'paired'], // legacy: pairing wins
    ['paired', false, false, 'unconfigured'],
    ['paired', false, true, 'byok'], // degrade: no pairing to honor the pref with
    ['paired', true, false, 'paired'],
    ['paired', true, true, 'paired'],
    ['byok', false, false, 'unconfigured'],
    ['byok', false, true, 'byok'],
    ['byok', true, false, 'paired'], // degrade: no key to honor the pref with
    ['byok', true, true, 'byok'], // the explicit switch actually switches
  ];

  it.each(cases)('pref=%s pairing=%s provider=%s → %s', (pref, pairing, provider, expected) => {
    expect(deriveBrainMode(pref, pairing, provider)).toBe(expected);
  });
});
