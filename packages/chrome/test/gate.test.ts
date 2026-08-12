import { describe, expect, it } from 'vitest';
import { isAllowed, normalizeHost, parseRuleInput, ruleLabel, shouldCapture } from '../src/gate.js';
import type { AllowRule } from '../src/schema.js';

function rule(host: string, includeSubdomains = false): AllowRule {
  return { host, includeSubdomains, addedAt: new Date(0).toISOString() };
}

describe('default deny', () => {
  it('denies everything with an empty allowlist', () => {
    expect(isAllowed('https://github.com/', [])).toBe(false);
    expect(isAllowed('https://docs.anthropic.com/x', [])).toBe(false);
  });
});

describe('scheme gate', () => {
  it.each([
    'chrome://extensions',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
    'file:///c:/secrets.txt',
    'about:blank',
    'data:text/html,<h1>x',
    'view-source:https://ok.com',
    'devtools://devtools/bundled/x.html',
    'javascript:alert(1)',
  ])('denies %s even with a rule that looks like it would match', (url) => {
    // Rules must never be able to reach a privileged scheme.
    const rules = [rule('extensions'), rule('ok.com'), rule('devtools', true), rule('c')];
    expect(isAllowed(url, rules)).toBe(false);
  });
});

describe('host matching', () => {
  it('matches an exact rule only for that exact host', () => {
    const rules = [rule('docs.anthropic.com')];
    expect(isAllowed('https://docs.anthropic.com/en/x', rules)).toBe(true);
    expect(isAllowed('https://anthropic.com/', rules)).toBe(false);
    expect(isAllowed('https://x.docs.anthropic.com/', rules)).toBe(false);
  });

  it('matches the apex and any depth of subdomain for a wildcard rule', () => {
    const rules = [rule('github.com', true)];
    for (const host of ['github.com', 'api.github.com', 'a.b.github.com']) {
      expect(isAllowed(`https://${host}/`, rules)).toBe(true);
    }
  });

  it('does NOT match evilgithub.com for *.github.com', () => {
    // THE LABEL-BOUNDARY CASE. A naive endsWith() passes this URL, and it is
    // the one place in the extension where a matching bug is a security bug.
    expect(isAllowed('https://evilgithub.com/', [rule('github.com', true)])).toBe(false);
    expect(isAllowed('https://notgithub.com/', [rule('github.com', true)])).toBe(false);
  });

  it('normalizes case, a trailing dot and a port away', () => {
    const rules = [rule('example.com')];
    expect(isAllowed('https://EXAMPLE.com/', rules)).toBe(true);
    expect(isAllowed('https://example.com./', rules)).toBe(true);
    expect(isAllowed('https://example.com:8443/x', rules)).toBe(true);
    expect(isAllowed('http://example.com/', rules)).toBe(true);
  });

  it('never throws on rubbish input', () => {
    expect(isAllowed('not a url', [rule('example.com')])).toBe(false);
    expect(isAllowed('', [rule('example.com')])).toBe(false);
    expect(isAllowed('https://', [rule('example.com')])).toBe(false);
  });
});

describe('normalizeHost', () => {
  it('lowercases, strips a trailing dot and unwraps IPv6 brackets', () => {
    expect(normalizeHost('EXAMPLE.com.')).toBe('example.com');
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('punycodes a unicode domain the same way a visited URL would', () => {
    expect(normalizeHost('bücher.de')).toBe(new URL('http://bücher.de').hostname);
  });

  it('rejects what cannot be a host', () => {
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('   ')).toBeNull();
    expect(normalizeHost('a b')).toBeNull();
  });
});

describe('parseRuleInput', () => {
  it('accepts a bare host', () => {
    const r = parseRuleInput('docs.anthropic.com');
    expect('rule' in r && r.rule).toMatchObject({ host: 'docs.anthropic.com', includeSubdomains: false });
  });

  it('accepts a full URL and keeps only its host', () => {
    const r = parseRuleInput('https://docs.anthropic.com/en/docs/x?y=1');
    expect('rule' in r && r.rule.host).toBe('docs.anthropic.com');
  });

  it('accepts a wildcard', () => {
    const r = parseRuleInput('*.github.com');
    expect('rule' in r && r.rule).toMatchObject({ host: 'github.com', includeSubdomains: true });
  });

  it.each([
    ['*', 'a bare wildcard'],
    ['*.com', 'a public suffix'],
    ['*.localhost', 'a single label'],
    ['*.127.0.0.1', 'a wildcarded IP'],
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['file:///etc/passwd', 'a non-capturable scheme'],
  ])('rejects %j (%s)', (input) => {
    expect('error' in parseRuleInput(input)).toBe(true);
  });

  it('accepts an exact IP or localhost', () => {
    expect('rule' in parseRuleInput('127.0.0.1')).toBe(true);
    expect('rule' in parseRuleInput('localhost')).toBe(true);
  });

  it('labels a wildcard rule in plain words', () => {
    expect(ruleLabel(rule('github.com', true))).toBe('github.com and subdomains');
    expect(ruleLabel(rule('github.com'))).toBe('github.com');
  });
});

describe('shouldCapture', () => {
  const rules = [rule('example.com', true)];

  it('is false for every rule set when capture is paused — including a matching one', () => {
    // Pause must be provably orthogonal to URL matching.
    expect(shouldCapture('https://example.com/', { enabled: false, rules })).toBe(false);
    expect(shouldCapture('https://sub.example.com/', { enabled: false, rules })).toBe(false);
    expect(shouldCapture('https://example.com/', { enabled: false, rules: [] })).toBe(false);
  });

  it('is true only when enabled AND allowed', () => {
    expect(shouldCapture('https://example.com/', { enabled: true, rules })).toBe(true);
    expect(shouldCapture('https://other.com/', { enabled: true, rules })).toBe(false);
    expect(shouldCapture('https://example.com/', { enabled: true, rules: [] })).toBe(false);
  });

  it('is false for a tab whose url the extension cannot see', () => {
    expect(shouldCapture(undefined, { enabled: true, rules })).toBe(false);
  });
});
