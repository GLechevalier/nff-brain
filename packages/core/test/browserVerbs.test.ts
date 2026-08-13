import { describe, expect, it } from 'vitest';
import {
  VERB_KINDS,
  isVerbKind,
  validateBrowserVerb,
  verbClass,
  type BrowserVerb,
  type VerbKind,
} from '../src/index.js';

describe('validateBrowserVerb', () => {
  it('accepts a ByRef pointer.click and defaults button/clickCount', () => {
    const v = validateBrowserVerb({ kind: 'pointer.click', target: { ref: 'e3', snapshotId: 's1' } });
    expect(v).toEqual({ kind: 'pointer.click', target: { ref: 'e3', snapshotId: 's1' }, button: 'left', clickCount: 1 });
  });

  it('accepts a ByPoint target and keeps only true modifiers', () => {
    const v = validateBrowserVerb({
      kind: 'pointer.click',
      target: { x: 10, y: 20 },
      button: 'right',
      clickCount: 2,
      modifiers: { ctrl: true, alt: false, shift: true },
    });
    expect(v).toEqual({
      kind: 'pointer.click',
      target: { x: 10, y: 20 },
      button: 'right',
      clickCount: 2,
      modifiers: { ctrl: true, shift: true },
    });
  });

  it('rejects a target that is neither a valid ref nor a point', () => {
    expect(validateBrowserVerb({ kind: 'pointer.click', target: { ref: 'e3' } })).toBeNull();
    expect(validateBrowserVerb({ kind: 'pointer.move', target: { x: 'a', y: 2 } })).toBeNull();
  });

  it('clamps clickCount to 1|2|3', () => {
    const v = validateBrowserVerb({ kind: 'pointer.click', target: { x: 0, y: 0 }, clickCount: 7 });
    expect((v as { clickCount: number }).clickCount).toBe(1);
  });

  it('drops a zero-delta wheel but keeps a one-axis scroll', () => {
    expect(validateBrowserVerb({ kind: 'scroll.wheel', target: { x: 1, y: 1 }, dx: 0, dy: 0 })).toBeNull();
    const v = validateBrowserVerb({ kind: 'scroll.wheel', target: { x: 1, y: 1 }, dy: 300 });
    expect(v).toMatchObject({ kind: 'scroll.wheel', dx: 0, dy: 300 });
  });

  it('accepts named keys and single printables, rejects control strings', () => {
    expect(validateBrowserVerb({ kind: 'key.press', key: 'Enter' })).toMatchObject({ key: 'Enter' });
    expect(validateBrowserVerb({ kind: 'key.press', key: 'a', modifiers: { ctrl: true } })).toMatchObject({
      key: 'a',
      modifiers: { ctrl: true },
    });
    expect(validateBrowserVerb({ kind: 'key.press', key: 'Frobnicate' })).toBeNull();
    expect(validateBrowserVerb({ kind: 'key.press', key: 'ab' })).toBeNull();
  });

  it('clamps key.type text and defaults no mode', () => {
    const long = 'x'.repeat(9000);
    const v = validateBrowserVerb({ kind: 'key.type', text: long }) as { text: string; mode?: string };
    expect(v.text.length).toBe(4000);
    expect(v.mode).toBeUndefined();
  });

  it('accepts only http/https for nav.goto and tab.open', () => {
    expect(validateBrowserVerb({ kind: 'nav.goto', url: 'https://a.com/x?q=1#h' })).toMatchObject({
      url: 'https://a.com/x?q=1#h',
    });
    expect(validateBrowserVerb({ kind: 'nav.goto', url: 'javascript:alert(1)' })).toBeNull();
    expect(validateBrowserVerb({ kind: 'nav.goto', url: 'file:///etc/passwd' })).toBeNull();
    expect(validateBrowserVerb({ kind: 'tab.open', url: 'chrome://settings' })).toBeNull();
  });

  it('requires a numeric tabId for tab ops', () => {
    expect(validateBrowserVerb({ kind: 'tab.close', tabId: 12 })).toEqual({ kind: 'tab.close', tabId: 12 });
    expect(validateBrowserVerb({ kind: 'tab.switch', tabId: 'x' })).toBeNull();
  });

  it('requires at least one upload path and caps the list', () => {
    expect(validateBrowserVerb({ kind: 'form.upload', ref: 'e1', snapshotId: 's1', paths: [] })).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => `/f${i}`);
    const v = validateBrowserVerb({ kind: 'form.upload', ref: 'e1', snapshotId: 's1', paths: many }) as {
      paths: string[];
    };
    expect(v.paths.length).toBe(10);
  });

  it('clamps page.zoom into Chrome range', () => {
    expect(validateBrowserVerb({ kind: 'page.zoom', factor: 99 })).toEqual({ kind: 'page.zoom', factor: 5 });
    expect(validateBrowserVerb({ kind: 'page.zoom', factor: 0 })).toEqual({ kind: 'page.zoom', factor: 0.25 });
  });

  it('rejects unknown kinds and non-objects', () => {
    expect(validateBrowserVerb({ kind: 'eval', code: '1' })).toBeNull();
    expect(validateBrowserVerb(null)).toBeNull();
    expect(validateBrowserVerb('pointer.click')).toBeNull();
    expect(validateBrowserVerb({})).toBeNull();
  });
});

describe('verbClass', () => {
  it('is total over every verb kind', () => {
    // A representative minimal-valid object per kind, so verbClass never sees undefined.
    const sample: Record<VerbKind, BrowserVerb> = {
      'pointer.move': { kind: 'pointer.move', target: { x: 0, y: 0 } },
      'pointer.click': { kind: 'pointer.click', target: { x: 0, y: 0 }, button: 'left', clickCount: 1 },
      'pointer.down': { kind: 'pointer.down', target: { x: 0, y: 0 }, button: 'left' },
      'pointer.up': { kind: 'pointer.up', target: { x: 0, y: 0 }, button: 'left' },
      'pointer.drag': { kind: 'pointer.drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
      'scroll.wheel': { kind: 'scroll.wheel', target: { x: 0, y: 0 }, dx: 0, dy: 1 },
      'scroll.intoView': { kind: 'scroll.intoView', ref: 'e1', snapshotId: 's1' },
      'key.press': { kind: 'key.press', key: 'Enter' },
      'key.type': { kind: 'key.type', text: 'a' },
      'element.focus': { kind: 'element.focus', ref: 'e1', snapshotId: 's1' },
      'form.setValue': { kind: 'form.setValue', ref: 'e1', snapshotId: 's1', value: 'x' },
      'form.upload': { kind: 'form.upload', ref: 'e1', snapshotId: 's1', paths: ['/f'] },
      'page.read': { kind: 'page.read' },
      'page.find': { kind: 'page.find', query: 'x' },
      'page.screenshot': { kind: 'page.screenshot' },
      'page.zoom': { kind: 'page.zoom', factor: 1 },
      'nav.goto': { kind: 'nav.goto', url: 'https://a.com' },
      'nav.back': { kind: 'nav.back' },
      'nav.forward': { kind: 'nav.forward' },
      'nav.reload': { kind: 'nav.reload' },
      'nav.waitFor': { kind: 'nav.waitFor', until: 'load' },
      'tab.open': { kind: 'tab.open', url: 'https://a.com' },
      'tab.close': { kind: 'tab.close', tabId: 1 },
      'tab.switch': { kind: 'tab.switch', tabId: 1 },
      'tab.duplicate': { kind: 'tab.duplicate', tabId: 1 },
      'tab.list': { kind: 'tab.list' },
      'dialog.handle': { kind: 'dialog.handle', accept: true },
      'touch.tap': { kind: 'touch.tap', target: { x: 0, y: 0 } },
      'touch.swipe': { kind: 'touch.swipe', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    };
    for (const kind of VERB_KINDS) {
      expect(['observe', 'interact', 'navigate', 'destructive']).toContain(verbClass(sample[kind]));
    }
    // Every declared kind has a sample — guards against adding a verb but forgetting its class.
    expect(Object.keys(sample).sort()).toEqual([...VERB_KINDS].sort());
  });

  it('classifies the sensitive verbs as destructive', () => {
    expect(verbClass({ kind: 'tab.close', tabId: 1 })).toBe('destructive');
    expect(verbClass({ kind: 'form.upload', ref: 'e1', snapshotId: 's1', paths: ['/f'] })).toBe('destructive');
    expect(verbClass({ kind: 'dialog.handle', accept: true })).toBe('destructive');
  });

  it('classifies reads as observe and typing as interact', () => {
    expect(verbClass({ kind: 'page.read' })).toBe('observe');
    expect(verbClass({ kind: 'key.type', text: 'x' })).toBe('interact');
  });
});

describe('isVerbKind', () => {
  it('recognizes real kinds and rejects junk', () => {
    expect(isVerbKind('pointer.click')).toBe(true);
    expect(isVerbKind('nav.goto')).toBe(true);
    expect(isVerbKind('eval')).toBe(false);
    expect(isVerbKind(42)).toBe(false);
  });
});
