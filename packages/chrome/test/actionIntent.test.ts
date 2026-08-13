import { describe, expect, it } from 'vitest';
import { detectActionIntent } from '../src/actionIntent.js';
import type { AgentAdapter } from '../src/agentTypes.js';

const LINKEDIN: AgentAdapter = {
  id: 'linkedin',
  label: 'LinkedIn — search & connect (autonomous)',
  hosts: ['www.linkedin.com'],
  originPatterns: ['https://www.linkedin.com/*'],
  matches: ['https://www.linkedin.com/*'],
  scriptFile: 'rec-linkedin-agent.js',
};

describe('detectActionIntent — adapter match (registered sites)', () => {
  it.each([
    'navigate to linkedin',
    'go to LinkedIn',
    'please open linkedin',
    'take me to linkedin.com',
    'can you visit LinkedIn for me',
  ])('matches %j — adapter alias + action verb both present', (message) => {
    const intent = detectActionIntent(message, [LINKEDIN]);
    expect(intent).toEqual({ kind: 'adapter', adapterId: 'linkedin', label: LINKEDIN.label, url: 'https://www.linkedin.com/' });
  });

  it.each(['what did I learn about linkedin outreach last week', 'summarize my linkedin notes'])(
    'does not match %j — alias present but no action verb',
    (message) => {
      expect(detectActionIntent(message, [LINKEDIN])).toBeNull();
    },
  );

  it('does not match an empty message', () => {
    expect(detectActionIntent('', [LINKEDIN])).toBeNull();
  });

  it('defaults to the real AGENT_ADAPTERS registry when no adapters arg is passed', () => {
    expect(detectActionIntent('navigate to linkedin')).toEqual({
      kind: 'adapter',
      adapterId: 'linkedin',
      label: LINKEDIN.label,
      url: 'https://www.linkedin.com/',
    });
  });

  it('an adapter alias match always wins over the generic fallback', () => {
    expect(detectActionIntent('navigate to linkedin', [LINKEDIN])).toEqual({
      kind: 'adapter',
      adapterId: 'linkedin',
      label: LINKEDIN.label,
      url: 'https://www.linkedin.com/',
    });
  });
});

describe('detectActionIntent — generic host fallback (any other site)', () => {
  it.each([
    ['navigate to google', 'google.com'],
    ['go to youtube please', 'youtube.com'],
    ['open developer.chrome.com for me', 'developer.chrome.com'],
    ['visit openai.com', 'openai.com'],
    ['take me to reddit', 'reddit.com'],
  ])('matches %j — falls back to a generic host guess when no adapter alias matches', (message, host) => {
    expect(detectActionIntent(message, [LINKEDIN])).toEqual({ kind: 'host', host, label: host, url: `https://${host}/` });
  });

  it.each(['open the pod bay doors', 'navigate to the settings page'])(
    'does not match %j — action verb present, but the remainder is not a single site-shaped token',
    (message) => {
      expect(detectActionIntent(message, [LINKEDIN])).toBeNull();
    },
  );

  it('does not match garbage/script-like input, even with a verb present', () => {
    expect(detectActionIntent('navigate to <script>alert(1)</script>', [LINKEDIN])).toBeNull();
  });

  it('falls back to a generic guess when the adapter list is empty, even for a name that would otherwise be an adapter alias', () => {
    expect(detectActionIntent('navigate to linkedin', [])).toEqual({
      kind: 'host',
      host: 'linkedin.com',
      label: 'linkedin.com',
      url: 'https://linkedin.com/',
    });
  });

  it('returns null when the adapter list is empty and the message has no clean single-token site either', () => {
    expect(detectActionIntent('navigate to the linkedin homepage', [])).toBeNull();
  });
});
