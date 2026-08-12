import { describe, expect, it } from 'vitest';
import { shouldRunAgentAction } from '../src/agentGate.js';

const LINKEDIN = { agentEnabled: true, hosts: ['www.linkedin.com'] };

describe('shouldRunAgentAction', () => {
  it('refuses when the adapter is disabled, even on an allowed host', () => {
    expect(shouldRunAgentAction('https://www.linkedin.com/search/', { ...LINKEDIN, agentEnabled: false })).toBe(false);
  });

  it('refuses a url with no host in the adapter list', () => {
    expect(shouldRunAgentAction('https://evil-linkedin.com/', LINKEDIN)).toBe(false);
    expect(shouldRunAgentAction('https://linkedin.com.evil.com/', LINKEDIN)).toBe(false);
  });

  it('refuses an absent url', () => {
    expect(shouldRunAgentAction(undefined, LINKEDIN)).toBe(false);
  });

  it('never throws on an unparseable url', () => {
    expect(shouldRunAgentAction('not a url', LINKEDIN)).toBe(false);
  });

  it('is case-insensitive on the hostname', () => {
    expect(shouldRunAgentAction('https://WWW.LinkedIn.com/search/', LINKEDIN)).toBe(true);
  });

  it('allows an exact host match when enabled', () => {
    expect(shouldRunAgentAction('https://www.linkedin.com/search/results/people/', LINKEDIN)).toBe(true);
  });

  it('never falls back to shouldCapture-style subdomain matching — the adapter host list is exact', () => {
    expect(shouldRunAgentAction('https://sub.www.linkedin.com/', LINKEDIN)).toBe(false);
  });
});
