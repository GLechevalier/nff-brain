import { describe, expect, it } from 'vitest';
import { NAVIGATE_TOOL_SPEC, validateNavigateUrl } from '../src/navigateTool.js';

describe('validateNavigateUrl', () => {
  it('accepts http and https urls', () => {
    expect(validateNavigateUrl('https://developer.chrome.com')).toEqual({ ok: true, url: 'https://developer.chrome.com/' });
    expect(validateNavigateUrl('http://example.com/path')).toEqual({ ok: true, url: 'http://example.com/path' });
  });

  it('trims surrounding whitespace', () => {
    expect(validateNavigateUrl('  https://developer.chrome.com  ')).toEqual({ ok: true, url: 'https://developer.chrome.com/' });
  });

  it('rejects a javascript: url', () => {
    const r = validateNavigateUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
  });

  it('rejects a chrome: url', () => {
    const r = validateNavigateUrl('chrome://settings');
    expect(r.ok).toBe(false);
  });

  it('rejects a file: url', () => {
    const r = validateNavigateUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('rejects a data: url', () => {
    const r = validateNavigateUrl('data:text/html,<script>alert(1)</script>');
    expect(r.ok).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(validateNavigateUrl('')).toEqual({ ok: false, reason: 'no url given' });
    expect(validateNavigateUrl('   ')).toEqual({ ok: false, reason: 'no url given' });
    expect(validateNavigateUrl(undefined)).toEqual({ ok: false, reason: 'no url given' });
    expect(validateNavigateUrl(42)).toEqual({ ok: false, reason: 'no url given' });
  });

  it('rejects unparseable text', () => {
    expect(validateNavigateUrl('not a url at all')).toEqual({ ok: false, reason: 'not a valid url' });
  });
});

describe('NAVIGATE_TOOL_SPEC', () => {
  it('never carries a literal https:// in its description (bundlePurity checks source text)', () => {
    expect(NAVIGATE_TOOL_SPEC.description).not.toMatch(/https?:\/\//);
    const props = NAVIGATE_TOOL_SPEC.input_schema.properties as Record<string, { description?: string }>;
    expect(props.url.description).not.toMatch(/https?:\/\//);
  });

  it('requires the url field', () => {
    expect(NAVIGATE_TOOL_SPEC.input_schema.required).toEqual(['url']);
  });
});
