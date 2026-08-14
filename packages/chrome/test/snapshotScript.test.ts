import { describe, expect, it } from 'vitest';
import {
  buildFingerprintSource,
  buildResolveSource,
  buildSnapshotSource,
  isRedacted,
  nameFromParts,
  refIndex,
  roleOf,
} from '../src/snapshotScript.js';

describe('roleOf', () => {
  it('prefers an explicit ARIA role', () => {
    expect(roleOf('div', 'slider', null)).toBe('slider');
  });
  it('maps tags and input types', () => {
    expect(roleOf('a', null, null)).toBe('link');
    expect(roleOf('button', null, null)).toBe('button');
    expect(roleOf('select', null, null)).toBe('combobox');
    expect(roleOf('textarea', null, null)).toBe('textbox');
    expect(roleOf('input', null, 'checkbox')).toBe('checkbox');
    expect(roleOf('input', null, 'radio')).toBe('radio');
    expect(roleOf('input', null, 'range')).toBe('slider');
    expect(roleOf('input', null, 'submit')).toBe('button');
    expect(roleOf('input', null, 'password')).toBe('textbox');
    expect(roleOf('input', null, null)).toBe('textbox');
  });
});

describe('isRedacted', () => {
  it('redacts password and sensitive autocomplete fields', () => {
    expect(isRedacted('input', 'password', null)).toBe(true);
    expect(isRedacted('input', 'text', 'current-password')).toBe(true);
    expect(isRedacted('input', 'text', 'one-time-code')).toBe(true);
    expect(isRedacted('input', 'text', 'cc-number')).toBe(true);
  });
  it('does not redact ordinary fields', () => {
    expect(isRedacted('input', 'text', null)).toBe(false);
    expect(isRedacted('input', 'email', 'email')).toBe(false);
    expect(isRedacted('textarea', null, null)).toBe(false);
  });
});

describe('nameFromParts', () => {
  it('takes the first non-empty, collapses whitespace, clamps', () => {
    expect(nameFromParts([null, '  Hello   world ', 'x'], 80)).toBe('Hello world');
    expect(nameFromParts([undefined, ''], 80)).toBe('');
    expect(nameFromParts(['a'.repeat(200)], 10)).toHaveLength(10);
  });
});

describe('refIndex', () => {
  it('parses e-prefixed indices and rejects junk', () => {
    expect(refIndex('e0')).toBe(0);
    expect(refIndex('e42')).toBe(42);
    expect(refIndex('x1')).toBeNull();
    expect(refIndex('e')).toBeNull();
  });
});

describe('buildSnapshotSource', () => {
  it('produces a self-contained IIFE carrying the helpers and args, no imports', () => {
    const src = buildSnapshotSource('s5', 'interactive');
    expect(src.startsWith('(function(){')).toBe(true);
    expect(src).toContain('function roleOf');
    expect(src).toContain('function isRedacted');
    expect(src).toContain('function nameFromParts');
    expect(src).toContain('"s5"');
    expect(src).toContain('"interactive"');
    // Globals passed as call-site string literals, not left as bare
    // module-level identifiers walkPage's body would close over — a minified
    // build renames ELS_GLOBAL/SNAP_GLOBAL references (e.g. to `Fn`/`Wn`)
    // with nothing in the injected page scope left to resolve that name,
    // which is exactly the "ReferenceError: Fn is not defined" read_page bug
    // this shape prevents. walkPage must read them via its OWN parameters
    // (elsKey/snapKey) instead, which a minifier renames consistently
    // wherever they're used because they're part of the SAME reflected
    // function.
    expect(src).toContain('"__nffEls"');
    expect(src).toContain('"__nffSnap"');
    expect(src).toContain('globalThis[elsKey]');
    expect(src).toContain('globalThis[snapKey]');
    expect(src).not.toMatch(/\bELS_GLOBAL\b|\bSNAP_GLOBAL\b/);
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
  });
});

describe('buildResolveSource', () => {
  it('checks the snapshot id and indexes the element array', () => {
    const src = buildResolveSource('s5', 3);
    expect(src).toContain('"s5"');
    expect(src).toContain('[3]');
    expect(src).toContain('stale');
    expect(src).toContain('gone');
    expect(src).not.toMatch(/\bELS_GLOBAL\b|\bSNAP_GLOBAL\b/);
  });

  it('reports an occlusion check and an element label alongside the point', () => {
    const src = buildResolveSource('s5', 3);
    expect(src).toContain('elementFromPoint');
    expect(src).toContain('occluded');
    expect(src).toContain('occluder');
    expect(src).toContain('label');
  });
});

describe('buildFingerprintSource', () => {
  it('is a self-contained IIFE with no imports', () => {
    const src = buildFingerprintSource();
    expect(src.startsWith('(function(){')).toBe(true);
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
