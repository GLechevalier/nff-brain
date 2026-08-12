// GitHub form-action classifier — PURE (no DOM, no chrome.*), so selector/URL
// rot is a unit-test failure with a name, not a silently dead recorder.

export interface GithubClassification {
  action: 'github.issue_opened' | 'github.pr_opened' | 'github.comment_posted';
  repo: string;
}

/** Classify a form's action URL by shape. Detection is URL-first by design. */
export function classifyGithubAction(actionUrl: string): GithubClassification | null {
  let u: URL;
  try {
    u = new URL(actionUrl, 'https://github.com');
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const repo = `${parts[0]}/${parts[1]}`;

  // /owner/repo/issues                → new issue form posts here
  if (parts.length === 3 && parts[2] === 'issues') return { action: 'github.issue_opened', repo };
  // /owner/repo/pull/create · /owner/repo/pulls (new PR form variants)
  if (parts[2] === 'pull' && parts[3] === 'create') return { action: 'github.pr_opened', repo };
  if (parts.length === 3 && parts[2] === 'pulls') return { action: 'github.pr_opened', repo };
  // /owner/repo/(issues|pull)/123/comments? → comment on an existing thread
  if (
    (parts[2] === 'issues' || parts[2] === 'pull') &&
    /^\d+$/.test(parts[3] ?? '') &&
    (parts[4] ?? '').startsWith('comment')
  ) {
    return { action: 'github.comment_posted', repo: `${repo}#${parts[3]}` };
  }
  return null;
}
