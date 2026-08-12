// The web agent adapter registry — metadata only, no chrome.*. Adding a
// second site is one entry here plus one content-script pair plus its line
// in build.mjs's CONTENT list (and, if it needs a new host, an
// optional_host_permissions entry — manifest.test.ts pins that set).

import type { AgentAdapter } from './agentTypes.js';

export const AGENT_ADAPTERS: readonly AgentAdapter[] = [
  {
    id: 'linkedin',
    label: 'LinkedIn — search & connect (autonomous)',
    hosts: ['www.linkedin.com'],
    originPatterns: ['https://www.linkedin.com/*'],
    matches: ['https://www.linkedin.com/*'],
    scriptFile: 'rec-linkedin-agent.js',
  },
];

export function agentAdapterById(id: string): AgentAdapter | undefined {
  return AGENT_ADAPTERS.find((a) => a.id === id);
}
