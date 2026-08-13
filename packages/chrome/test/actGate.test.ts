import { describe, expect, it } from 'vitest';
import { decideAct, isRestrictedUrl, originOf, type GateDecision } from '../src/actGate.js';
import type { VerbClass } from '@nff-brain/core/browserVerbs';

function d(verbClass: VerbClass, persisted: 'always' | 'never' | undefined, sessionGranted: boolean): GateDecision {
  return decideAct({ verbClass, persisted, sessionGranted });
}

describe('decideAct', () => {
  it('always allows observe and navigate regardless of grant', () => {
    for (const p of ['always', 'never', undefined] as const) {
      expect(d('observe', p, false)).toBe('allow');
      expect(d('navigate', p, false)).toBe('allow');
    }
  });

  it('prompts for the first interact and allows once granted', () => {
    expect(d('interact', undefined, false)).toBe('prompt');
    expect(d('interact', undefined, true)).toBe('allow'); // session "once"
    expect(d('interact', 'always', false)).toBe('allow');
  });

  it('denies interact on a "never" origin even with a session grant', () => {
    expect(d('interact', 'never', true)).toBe('deny');
  });

  it('confirms destructive every run unless the origin is "always"', () => {
    expect(d('destructive', undefined, false)).toBe('prompt');
    expect(d('destructive', undefined, true)).toBe('prompt'); // a "once" is NOT enough
    expect(d('destructive', 'always', false)).toBe('allow');
    expect(d('destructive', 'never', true)).toBe('deny');
  });
});

describe('originOf', () => {
  it('reduces a url to scheme://host[:port]', () => {
    expect(originOf('https://www.linkedin.com/search?q=x')).toBe('https://www.linkedin.com');
    expect(originOf('http://localhost:3000/a')).toBe('http://localhost:3000');
  });
  it('returns null for junk', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('isRestrictedUrl', () => {
  it('refuses non-http(s) and browser-internal targets', () => {
    expect(isRestrictedUrl('chrome://settings')).toBe(true);
    expect(isRestrictedUrl('chrome-extension://abc/page.html')).toBe(true);
    expect(isRestrictedUrl('file:///c:/x')).toBe(true);
    expect(isRestrictedUrl('about:blank')).toBe(true);
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe(true);
    expect(isRestrictedUrl(undefined)).toBe(true);
  });
  it('permits ordinary web pages', () => {
    expect(isRestrictedUrl('https://www.linkedin.com')).toBe(false);
    expect(isRestrictedUrl('http://example.com/x')).toBe(false);
  });
});
