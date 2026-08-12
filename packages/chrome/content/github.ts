// GitHub recorder: issues, PRs and comments THE USER writes. Injected only
// after the user enabled the GitHub recorder and granted https://github.com/*.
//
// Detection is FORM-SIGNAL-FIRST, not selector-first, to resist DOM churn: a
// capture-phase submit listener classifies by the form's action URL shape and
// reads the title from the form's own fields at submit time. The bright line
// (also stated in the store listing): this script observes only form
// submissions the user makes. It never reads repositories, profiles, or any
// page content the user did not act on, and it never automates anything.

import { classifyGithubAction } from './githubClassify.js';
import type { GithubClassification } from './githubClassify.js';
import { dayBucket, emit, firstLine } from './runtime.js';

/** Title from the form's own inputs — read at submit time, never earlier. */
export function titleFromForm(form: HTMLFormElement, action: GithubClassification['action']): string {
  if (action === 'github.comment_posted') {
    const body = form.querySelector<HTMLTextAreaElement>('textarea[name="comment[body]"], textarea[name="body"]');
    return body ? firstLine(body.value) : '';
  }
  const title = form.querySelector<HTMLInputElement>(
    'input[name="issue[title]"], input[name="pull_request[title]"], input[name="title"]',
  );
  return title?.value.trim().slice(0, 120) ?? '';
}

document.addEventListener(
  'submit',
  (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const classified = classifyGithubAction(form.action);
    if (!classified) return;
    const title = titleFromForm(form, classified.action);
    if (!title) return; // an empty submit is going to fail validation anyway

    emit({
      adapter: 'github',
      action: classified.action,
      // repo#number when known, else title+day — stable enough that a
      // double-fire of the same submit dedupes, distinct submits do not.
      key: `${classified.action}:${classified.repo}:${title}:${dayBucket()}`,
      title,
      fields: { repo: classified.repo },
    });
  },
  { capture: true },
);
