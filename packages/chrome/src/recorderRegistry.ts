// The adapter registry — metadata only, no chrome.*. Adding a site is one
// entry here plus one file in content/ plus its line in build.mjs's CONTENT
// list (and the matching optional_host_permissions entry in manifest.json,
// which test/manifest.test.ts pins).

import type { RecorderAdapter } from './recorderTypes.js';

export const ADAPTERS: readonly RecorderAdapter[] = [
  {
    id: 'github',
    label: 'GitHub — issues, PRs & comments you write',
    hosts: ['github.com'],
    originPatterns: ['https://github.com/*'],
    matches: ['https://github.com/*'],
    scriptFile: 'rec-github.js',
    actions: ['github.issue_opened', 'github.pr_opened', 'github.comment_posted'],
  },
  {
    id: 'linkedin',
    label: 'LinkedIn — invites you send',
    hosts: ['www.linkedin.com'],
    originPatterns: ['https://www.linkedin.com/*'],
    matches: ['https://www.linkedin.com/*'],
    scriptFile: 'rec-linkedin.js',
    actions: ['linkedin.invite_sent'],
  },
];

export function adapterById(id: string): RecorderAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
