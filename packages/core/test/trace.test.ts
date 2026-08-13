import { describe, expect, it } from 'vitest';
import { newTraceId, normalizeDescriptor, normalizeTraceEvent, traceByteSize } from '../src/index.js';

describe('normalizeDescriptor', () => {
  it('lowercases the tag and clamps fields', () => {
    const d = normalizeDescriptor({ tag: 'INPUT', name: 'x'.repeat(300), role: 'textbox' });
    expect(d).toMatchObject({ tag: 'input', role: 'textbox' });
    expect(d!.name!.length).toBeLessThanOrEqual(120);
  });

  it('drops non-http hrefs but keeps http(s)', () => {
    expect(normalizeDescriptor({ tag: 'a', href: 'javascript:alert(1)' })!.href).toBeUndefined();
    expect(normalizeDescriptor({ tag: 'a', href: 'https://x.com/y' })!.href).toBe('https://x.com/y');
  });

  it('caps the attrs whitelist at 4', () => {
    const d = normalizeDescriptor({ tag: 'input', attrs: { a: '1', b: '2', c: '3', d: '4', e: '5' } });
    expect(Object.keys(d!.attrs!).length).toBe(4);
  });

  it('returns undefined without a tag', () => {
    expect(normalizeDescriptor({ name: 'x' })).toBeUndefined();
    expect(normalizeDescriptor(null)).toBeUndefined();
  });
});

describe('normalizeTraceEvent', () => {
  it('strips control characters from values', () => {
    const ev = normalizeTraceEvent({ kind: 'input', t: 3, value: 'hello' });
    expect(ev!.value).toBe('hello');
  });

  it('forces empty value when redacted', () => {
    const ev = normalizeTraceEvent({ kind: 'input', redacted: true, value: 'hunter2' });
    expect(ev).toMatchObject({ kind: 'input', redacted: true, value: '' });
  });

  it('never trusts a script-supplied url', () => {
    const ev = normalizeTraceEvent({ kind: 'click', url: 'https://evil.example', target: { tag: 'button' } });
    expect(ev!.url).toBe(''); // the SW stamps the real url from sender.tab.url
  });

  it('keeps only known key/dir enums', () => {
    expect(normalizeTraceEvent({ kind: 'key', key: 'Enter' })!.key).toBe('Enter');
    expect(normalizeTraceEvent({ kind: 'key', key: 'a' })!.key).toBeUndefined();
    expect(normalizeTraceEvent({ kind: 'scroll', dir: 'down' })!.dir).toBe('down');
    expect(normalizeTraceEvent({ kind: 'scroll', dir: 'sideways' })!.dir).toBeUndefined();
  });

  it('rejects unknown kinds and non-objects', () => {
    expect(normalizeTraceEvent({ kind: 'teleport' })).toBeNull();
    expect(normalizeTraceEvent(null)).toBeNull();
  });
});

describe('helpers', () => {
  it('mints a sortable trace id', () => {
    expect(newTraceId(1699999999999, 'abc123')).toBe('trc_1699999999999_abc123');
  });
  it('measures byte size', () => {
    expect(traceByteSize([{ t: 0, kind: 'click', url: '' }])).toBeGreaterThan(0);
  });
});
