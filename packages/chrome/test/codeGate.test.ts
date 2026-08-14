import { describe, expect, it } from 'vitest';
import { decideCode } from '../src/codeGate.js';

describe('decideCode', () => {
  it('reads are free — attaching the folder is the consent', () => {
    expect(decideCode({ cls: 'code-read', sessionGranted: false })).toBe('allow');
    expect(decideCode({ cls: 'code-read', sessionGranted: true })).toBe('allow');
  });

  it('writes and execs prompt until the run carries an Always', () => {
    expect(decideCode({ cls: 'code-write', sessionGranted: false })).toBe('prompt');
    expect(decideCode({ cls: 'code-write', sessionGranted: true })).toBe('allow');
    expect(decideCode({ cls: 'code-exec', sessionGranted: false })).toBe('prompt');
    expect(decideCode({ cls: 'code-exec', sessionGranted: true })).toBe('allow');
  });
});
