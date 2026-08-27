import { describe, expect, it } from 'vitest';
import { classifyGithubAction } from '../content/githubClassify.js';
import { canonicalProfileUrl, inviteeFromText, isSendInviteLabel } from '../content/linkedinClassify.js';
import {
  formatRecorderClip,
  pushRecorderSeen,
  recorderSeenRecently,
  validateRecorderEvent,
} from '../src/recorderFormat.js';
import { ADAPTERS, adapterById } from '../src/recorderRegistry.js';
import { RECORDER_SEEN_MAX, RECORDER_SEEN_TTL_MS } from '../src/recorderTypes.js';
import type { RecorderSeenEntry } from '../src/recorderTypes.js';

describe('validateRecorderEvent', () => {
  const good = {
    type: 'recorderEvent',
    adapter: 'github',
    action: 'github.issue_opened',
    key: 'k',
    at: '2026-08-11T00:00:00.000Z',
    title: 'Fix the race',
    fields: { repo: 'o/r' },
  };

  it('accepts the real shape and clamps strings', () => {
    const v = validateRecorderEvent({ ...good, title: 'x'.repeat(1000) })!;
    expect(v.title).toHaveLength(300);
    expect(v.fields.repo).toBe('o/r');
  });

  it('rejects junk, wrong types, and empty required fields', () => {
    expect(validateRecorderEvent(null)).toBeNull();
    expect(validateRecorderEvent({})).toBeNull();
    expect(validateRecorderEvent({ ...good, type: 'other' })).toBeNull();
    expect(validateRecorderEvent({ ...good, title: '  ' })).toBeNull();
    expect(validateRecorderEvent({ ...good, key: 42 })).toBeNull();
  });

  it('drops non-string field values and caps the field count', () => {
    const fields: Record<string, unknown> = { evil: { nested: true } };
    for (let i = 0; i < 20; i++) fields[`f${i}`] = 'v';
    const v = validateRecorderEvent({ ...good, fields })!;
    expect(Object.keys(v.fields).length).toBeLessThanOrEqual(8);
    expect('evil' in v.fields).toBe(false);
  });
});

describe('formatRecorderClip', () => {
  it('emits the machine-recognizable recorder-event block', () => {
    const { text, title } = formatRecorderClip({
      type: 'recorderEvent',
      adapter: 'github',
      action: 'github.pr_opened',
      key: 'k',
      at: '2026-08-11T00:00:00.000Z',
      title: 'Add drain',
      fields: { repo: 'o/r' },
    });
    expect(text.split('\n')[0]).toBe('recorder-event github.pr_opened');
    expect(text).toContain('title: Add drain');
    expect(text).toContain('repo: o/r');
    expect(title).toBe('Add drain');
  });
});

describe('recorder dedupe ring', () => {
  const t0 = 1_000_000;
  it('dedupes inside the 24h TTL, admits after, caps the ring', () => {
    let ring: RecorderSeenEntry[] = pushRecorderSeen([], 'a', t0);
    expect(recorderSeenRecently(ring, 'a', t0 + 1000)).toBe(true);
    expect(recorderSeenRecently(ring, 'a', t0 + RECORDER_SEEN_TTL_MS + 1)).toBe(false);
    for (let i = 0; i < RECORDER_SEEN_MAX + 50; i++) ring = pushRecorderSeen(ring, `k${i}`, t0 + i);
    expect(ring.length).toBeLessThanOrEqual(RECORDER_SEEN_MAX);
  });
});

describe('github classifier (pure — selector rot is a test failure here)', () => {
  it('classifies new issues, new PRs and comments by form-action shape', () => {
    expect(classifyGithubAction('https://github.com/o/r/issues')).toEqual({
      action: 'github.issue_opened',
      repo: 'o/r',
    });
    expect(classifyGithubAction('https://github.com/o/r/pull/create?base=main')).toEqual({
      action: 'github.pr_opened',
      repo: 'o/r',
    });
    expect(classifyGithubAction('/o/r/issues/123/comments')).toEqual({
      action: 'github.comment_posted',
      repo: 'o/r#123',
    });
  });

  it('rejects other hosts and unrelated forms', () => {
    expect(classifyGithubAction('https://evil.example/o/r/issues')).toBeNull();
    expect(classifyGithubAction('https://github.com/search')).toBeNull();
    expect(classifyGithubAction('https://github.com/o/r/stargazers')).toBeNull();
    expect(classifyGithubAction('not a url at all')).toBeNull(); // resolves relative, too few path parts
  });
});

describe('linkedin classifier (pure)', () => {
  it('recognizes send-invitation button labels and nothing else', () => {
    for (const label of ['Send now', 'Send invitation', 'send without a note', 'Send invitation to Ada Lovelace']) {
      expect(isSendInviteLabel(label), label).toBe(true);
    }
    for (const label of ['Send message', 'Sending', 'Follow', 'Connect']) {
      expect(isSendInviteLabel(label), label).toBe(false);
    }
  });

  it('extracts the invitee from modal headings and button labels', () => {
    expect(inviteeFromText('Invite Ada Lovelace to connect')).toBe('Ada Lovelace');
    expect(inviteeFromText('Send invitation to Grace Hopper')).toBe('Grace Hopper');
    expect(inviteeFromText('Manage your network')).toBe('');
  });

  it('canonicalizes profile URLs and refuses everything else', () => {
    expect(canonicalProfileUrl('https://www.linkedin.com/in/ada-lovelace/')).toBe(
      'https://www.linkedin.com/in/ada-lovelace',
    );
    expect(canonicalProfileUrl('https://linkedin.com/in/ada?trk=x')).toBe('https://www.linkedin.com/in/ada');
    expect(canonicalProfileUrl('https://www.linkedin.com/in/ada/details/experience/')).toBe(
      'https://www.linkedin.com/in/ada',
    );
    expect(canonicalProfileUrl('https://www.linkedin.com/search/results/people/')).toBe('');
    expect(canonicalProfileUrl('https://evil.example/in/ada')).toBe('');
    expect(canonicalProfileUrl('not a url')).toBe('');
  });
});

describe('registry', () => {
  it('every adapter names a script file and declared actions', () => {
    expect(ADAPTERS.length).toBe(2);
    for (const a of ADAPTERS) {
      expect(a.scriptFile).toMatch(/^rec-[a-z]+\.js$/);
      expect(a.actions.length).toBeGreaterThan(0);
      expect(a.hosts.length).toBeGreaterThan(0);
      expect(adapterById(a.id)).toBe(a);
    }
  });
});
