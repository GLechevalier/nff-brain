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

describe('detectActionIntent', () => {
  it.each([
    'navigate to linkedin',
    'go to LinkedIn',
    'please open linkedin',
    'take me to linkedin.com',
    'can you visit LinkedIn for me',
  ])('matches %j — adapter alias + action verb both present', (message) => {
    const intent = detectActionIntent(message, [LINKEDIN]);
    expect(intent).toEqual({ adapterId: 'linkedin', label: LINKEDIN.label, url: 'https://www.linkedin.com/' });
  });

  it.each([
    'what did I learn about linkedin outreach last week',
    'summarize my linkedin notes',
  ])('does not match %j — alias present but no action verb', (message) => {
    expect(detectActionIntent(message, [LINKEDIN])).toBeNull();
  });

  it.each([
    'open the pod bay doors',
    'navigate to the settings page',
  ])('does not match %j — action verb present but no adapter alias', (message) => {
    expect(detectActionIntent(message, [LINKEDIN])).toBeNull();
  });

  it('does not match an empty message', () => {
    expect(detectActionIntent('', [LINKEDIN])).toBeNull();
  });

  it('returns null when given an empty adapter list, regardless of message', () => {
    expect(detectActionIntent('navigate to linkedin', [])).toBeNull();
  });

  it('defaults to the real AGENT_ADAPTERS registry when no adapters arg is passed', () => {
    expect(detectActionIntent('navigate to linkedin')).toEqual({
      adapterId: 'linkedin',
      label: LINKEDIN.label,
      url: 'https://www.linkedin.com/',
    });
  });
});
