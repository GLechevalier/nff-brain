// THE CAPTURE CHOKE POINT. Named after the invariant rather than after
// "allowlist", because three of the MVP's acceptance criteria collapse onto one
// exported function and that function needs to be greppable by name.
//
// Zero imports beyond types, no chrome.*, no node:* — vitest imports it
// directly and bundlePurity.test.ts asserts it stays that way.

import type { AllowRule } from './schema.js';

/**
 * The ONLY schemes that are ever capturable, checked BEFORE any rule matching
 * so that no rule a user types can ever open chrome://, chrome-extension://,
 * file://, about:, data:, view-source:, devtools: or blob:.
 */
export const CAPTURABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Lowercase, strip a trailing dot, strip IPv6 brackets. Returns null when the
 * input cannot be a host.
 *
 * Everything is routed through the URL parser so that a typed unicode domain
 * normalizes (punycode, case) identically to a visited one — otherwise a rule
 * added by typing would silently fail to match the same site when browsed.
 */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  // IPv6 must reach the URL parser WITH its brackets — http://::1 is invalid —
  // so wrap a bare literal rather than stripping first. Brackets come off the
  // parsed hostname below, matching what isAllowed() does to a visited URL.
  const authority =
    !trimmed.startsWith('[') && (trimmed.match(/:/g)?.length ?? 0) >= 2 ? `[${trimmed}]` : trimmed;

  let host: string;
  try {
    host = new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
  const cleaned = stripHost(host);
  return cleaned.length ? cleaned : null;
}

/** Bracket-free, dot-free, lowercase — the one canonical host spelling. */
function stripHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Accepts what people actually paste: a bare host, `*.host`, or a full URL. */
export function parseRuleInput(raw: string, now = new Date()): { rule: AllowRule } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'type a domain first' };

  // A full URL: take its host, and refuse the schemes we can never capture.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      return { error: `${trimmed} is not a valid URL` };
    }
    if (!CAPTURABLE_SCHEMES.has(u.protocol)) return { error: `nff-brain only captures http and https pages` };
    const host = normalizeHost(u.hostname);
    return host ? { rule: { host, includeSubdomains: false, addedAt: now.toISOString() } } : { error: 'no host in that URL' };
  }

  const wildcard = trimmed.startsWith('*.');
  const bare = wildcard ? trimmed.slice(2) : trimmed;
  if (bare === '*' || bare === '') return { error: 'a bare * would allow every site' };

  const host = normalizeHost(bare);
  if (!host) return { error: `${trimmed} is not a domain` };
  if (host.includes('/')) return { error: 'paths are not supported yet — add the domain' };

  if (wildcard) {
    // A full public-suffix list is a megabyte of data and a dependency, neither
    // of which belongs in a popup. Requiring two labels catches the
    // catastrophic cases (*.com, *.localhost). It does NOT catch *.co.uk — that
    // limitation is documented in the README rather than pretended away.
    if (IPV4.test(host)) return { error: `*.${host} is meaningless for an IP address` };
    if (host.split('.').filter(Boolean).length < 2) return { error: `*.${host} is far too broad` };
  }

  return { rule: { host, includeSubdomains: wildcard, addedAt: now.toISOString() } };
}

export function ruleLabel(rule: AllowRule): string {
  return rule.includeSubdomains ? `${rule.host} and subdomains` : rule.host;
}

function matches(host: string, rule: AllowRule): boolean {
  if (host === rule.host) return true;
  // LABEL-BOUNDARY MATCHING, never a substring test: endsWith('github.com')
  // also matches evilgithub.com. This is the one line in the extension where a
  // bug is a security bug, and it has its own test case.
  return rule.includeSubdomains && host.endsWith(`.${rule.host}`);
}

/** NEVER THROWS. An unparseable URL is false, not an exception. */
export function isAllowed(url: string, rules: readonly AllowRule[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!CAPTURABLE_SCHEMES.has(parsed.protocol)) return false;

  // The PORT IS IGNORED. Users think in sites, not ports, and a per-port list
  // creates the trap where the same site is captured on 443 but silently not on
  // 8443. Said plainly in the popup's help text.
  const host = stripHost(parsed.hostname);
  if (!host) return false;

  for (const rule of rules) if (matches(host, rule)) return true;
  return false; // an empty list denies everything — default deny, for free
}

/**
 * THE choke point. Every capture entry point — the context menu today, content
 * scripts in item 4 — calls exactly this, with `state` read from storage AT THE
 * MOMENT OF THE EVENT and never from a cached copy. That is what makes pausing
 * take effect on the very next event rather than on the next page load.
 */
export function shouldCapture(
  url: string | undefined,
  state: { enabled: boolean; rules: readonly AllowRule[] },
): boolean {
  if (!state.enabled) return false;
  if (!url) return false;
  return isAllowed(url, state.rules);
}
