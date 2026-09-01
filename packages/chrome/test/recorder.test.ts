import { describe, expect, it } from 'vitest';
import { classifyGithubAction } from '../content/githubClassify.js';
import {
  canonicalProfileUrl,
  inviteeFromText,
  isConnectComponentKey,
  isSendInviteLabel,
  vanityFromPreloadHref,
} from '../content/linkedinClassify.js';
import {
  formatRecorderClip,
  pushRecorderSeen,
  recorderSeenRecently,
  validateRecorderEvent,
} from '../src/recorderFormat.js';
import {
  acceptSeenHas,
  acceptSeenPut,
  ACCEPT_SEEN_TTL_MS,
  classifyAcceptedFromResponse,
  classifyInviteRequest,
  classifyMessageSend,
  dayBucket,
  endpointOf,
  isRecentConnectionsResponse,
  nameFromTabTitle,
  NETLOG_MAX,
  parseMessageText,
  PENDING_INVITE_MAX,
  PENDING_INVITE_TTL_MS,
  pushNetLog,
  pushPendingInvite,
  takePendingInvite,
  type NetLogEntry,
  type PendingInvite,
} from '../src/inviteNet.js';
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
    for (const label of [
      'Send now',
      'Send invitation',
      'send without a note',
      'Send invitation to Ada Lovelace',
      'Envoyer sans note',
      'Envoyer maintenant',
      'envoyer une invitation à Ada Lovelace',
    ]) {
      expect(isSendInviteLabel(label), label).toBe(true);
    }
    for (const label of ['Send message', 'Sending', 'Follow', 'Connect', 'Se connecter', 'Envoyer un message']) {
      expect(isSendInviteLabel(label), label).toBe(false);
    }
  });

  it('extracts the invitee from modal headings and button labels', () => {
    expect(inviteeFromText('Invite Ada Lovelace to connect')).toBe('Ada Lovelace');
    expect(inviteeFromText('Send invitation to Grace Hopper')).toBe('Grace Hopper');
    expect(inviteeFromText('Manage your network')).toBe('');
  });

  it('extracts the invitee from Connect-button aria-labels (en + fr)', () => {
    expect(inviteeFromText('Invite Myron Sydorov to join your network')).toBe('Myron Sydorov');
    expect(inviteeFromText('Inviter Alexander Fritsch à rejoindre votre réseau')).toBe('Alexander Fritsch');
  });

  it('recognizes the Connect componentkey state, never the pending/withdraw state', () => {
    expect(isConnectComponentKey('ConnectButtonstate:invitation:urn:li:member:935794982_connect')).toBe(true);
    // "En attente" — clicking WITHDRAWS the invite; must never park identity.
    expect(isConnectComponentKey('ConnectButtonstate:invitation:urn:li:member:857110426_pending')).toBe(false);
    expect(isConnectComponentKey('SearchResultsACoAADMWd5oB')).toBe(false);
    expect(isConnectComponentKey('')).toBe(false);
  });

  it('pulls the invitee slug from a Connect button preload href and nothing else', () => {
    expect(vanityFromPreloadHref('https://www.linkedin.com/preload/custom-invite/?vanityName=myron-sydorov-271a693a8')).toBe(
      'myron-sydorov-271a693a8',
    );
    expect(vanityFromPreloadHref('https://www.linkedin.com/preload/custom-invite/?trk=x&vanityName=ada%2Dl')).toBe('ada-l');
    expect(vanityFromPreloadHref('https://www.linkedin.com/preload/custom-invite/?other=1')).toBe('');
    expect(vanityFromPreloadHref('https://evil.example/preload/custom-invite/?vanityName=ada')).toBe('');
    expect(vanityFromPreloadHref('https://www.linkedin.com/in/ada')).toBe('');
    expect(vanityFromPreloadHref('not a url')).toBe('');
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

describe('invite network classifier (pure — locale-independent detection)', () => {
  const V = 'https://www.linkedin.com/voyager/api';

  it('matches successful invitation-sending POSTs across endpoint renames', () => {
    for (const url of [
      `${V}/voyagerRelationshipsDashMemberRelationships?action=sendInvitation`,
      `${V}/growth/normInvitations`,
      `${V}/voyagerRelationshipsDashInvitations?action=create`,
    ]) {
      expect(classifyInviteRequest('POST', url, 200), url).toBe(true);
    }
  });

  it('rejects non-POSTs, failures, other hosts, and not-you-inviting verbs', () => {
    const send = `${V}/growth/normInvitations`;
    expect(classifyInviteRequest('GET', send, 200)).toBe(false);
    expect(classifyInviteRequest('POST', send, 429)).toBe(false);
    expect(classifyInviteRequest('POST', 'https://evil.example/voyager/api/normInvitations', 200)).toBe(false);
    for (const url of [
      `${V}/voyagerRelationshipsDashMemberRelationships?action=verifyQuickConnect`, // modal open, not send
      `${V}/relationships/invitations/123?action=withdraw`,
      `${V}/relationships/invitations/123?action=accept`,
      `${V}/relationships/invitations/123?action=ignore`,
      `${V}/voyagerRelationshipsDashInvitationsSummary`,
      `${V}/messaging/conversations`,
    ]) {
      expect(classifyInviteRequest('POST', url, 200), url).toBe(false);
    }
  });

  it('extracts the invitee name from a profile tab title in any locale', () => {
    expect(nameFromTabTitle('Merchrist K. | LinkedIn')).toBe('Merchrist K.');
    expect(nameFromTabTitle('(3) Ada Lovelace | LinkedIn')).toBe('Ada Lovelace');
    expect(nameFromTabTitle('Recherche | LinkedIn')).toBe('Recherche'); // caller gates on /in/ URL, not us
    expect(nameFromTabTitle('LinkedIn')).toBe('');
    expect(nameFromTabTitle('Something else entirely')).toBe('');
  });

  it('buckets by day exactly like the content-script emitter (shared dedupe key)', () => {
    expect(dayBucket(new Date('2026-08-27T23:59:00Z'))).toBe('2026-08-27');
  });
});

describe('pending invite correlation (pure — click identity → net confirmation)', () => {
  const t0 = 1_000_000;
  const mk = (tabId: number, slug: string, atMs: number, extra: Partial<PendingInvite> = {}): PendingInvite => ({
    tabId,
    name: `Name ${slug}`,
    linkedin: `https://www.linkedin.com/in/${slug}`,
    slug,
    note: '',
    atMs,
    ...extra,
  });

  it('push TTL-filters and caps', () => {
    let list = pushPendingInvite([], mk(1, 'stale', t0), t0);
    list = pushPendingInvite(list, mk(1, 'fresh', t0 + PENDING_INVITE_TTL_MS + 1), t0 + PENDING_INVITE_TTL_MS + 1);
    expect(list.map((p) => p.slug)).toEqual(['fresh']);
    for (let i = 0; i < PENDING_INVITE_MAX + 10; i++) list = pushPendingInvite(list, mk(1, `s${i}`, t0), t0);
    expect(list.length).toBeLessThanOrEqual(PENDING_INVITE_MAX);
  });

  it('take = newest fresh entry for the tab, clearing the whole tab queue', () => {
    // Cancelled-modal scenario: an orphan older click (A) must NOT be handed
    // to the invite that a later click (B) actually caused.
    const list = [mk(1, 'a-orphan', t0), mk(1, 'b-real', t0 + 500), mk(2, 'other-tab', t0 + 600)];
    const { entry, rest } = takePendingInvite(list, 1, t0 + 1000);
    expect(entry?.slug).toBe('b-real');
    expect(rest.map((p) => p.slug)).toEqual(['other-tab']); // tab 1 fully cleared, tab 2 untouched
  });

  it('take skips stale entries and misses cleanly', () => {
    const list = [mk(1, 'old', t0)];
    expect(takePendingInvite(list, 1, t0 + PENDING_INVITE_TTL_MS + 1).entry).toBeNull();
    expect(takePendingInvite(list, 99, t0 + 1).entry).toBeNull();
  });

  it('take MERGES a Connect click with the modal-Send click that follows it', () => {
    // Connect-anchor click knows the invitee (slug/linkedin/name); the later
    // modal-Send click knows the typed note (and only a dialog-derived
    // linkedin, which must not displace the slug-derived one).
    const list = [
      mk(1, 'ada-l', t0),
      mk(1, '', t0 + 500, { name: 'Ada Lovelace', linkedin: 'https://www.linkedin.com/in/page-owner', note: 'hi Ada!' }),
    ];
    const { entry } = takePendingInvite(list, 1, t0 + 1000);
    expect(entry?.slug).toBe('ada-l'); // slug survives the newer slugless entry
    expect(entry?.name).toBe('Ada Lovelace'); // newest non-empty name wins
    expect(entry?.note).toBe('hi Ada!');
  });

  it('a modal-Send-only entry (no slug) merges to a note-carrying, identity-free record', () => {
    const list = [mk(2, '', t0, { name: 'Grace', linkedin: '', note: 'bonjour' })];
    const { entry } = takePendingInvite(list, 2, t0 + 1);
    expect(entry?.slug).toBe('');
    expect(entry?.note).toBe('bonjour');
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

  it('linkedin adapter declares the accept + message actions and the MAIN-world tap', () => {
    const li = adapterById('linkedin')!;
    expect(li.actions).toContain('linkedin.invite_accepted');
    expect(li.actions).toContain('linkedin.message_sent');
    expect(li.mainWorldScriptFile).toBe('rec-linkedin-net.js');
  });
});

// ── the network-tap pure classifiers ─────────────────────────────────────────

describe('classifyMessageSend', () => {
  const V = 'https://www.linkedin.com/voyager/api/';
  it('accepts a createMessage / messengerMessages POST', () => {
    expect(classifyMessageSend('POST', `${V}voyagerMessagingDashMessengerMessages?action=createMessage`)).toBe(true);
    expect(classifyMessageSend('post', `${V}messaging/conversations/x/events?action=create`)).toBe(true);
  });
  it('rejects GETs, non-messaging POSTs, and non-voyager URLs', () => {
    expect(classifyMessageSend('GET', `${V}voyagerMessagingDashMessengerMessages`)).toBe(false);
    expect(classifyMessageSend('POST', `${V}relationships/invitations`)).toBe(false);
    expect(classifyMessageSend('POST', 'https://www.linkedin.com/messaging/thread/1')).toBe(false);
  });
});

describe('parseMessageText', () => {
  it('digs the text out of the common shapes', () => {
    expect(parseMessageText(JSON.stringify({ message: { body: { text: 'hi there' } } }))).toBe('hi there');
    expect(parseMessageText(JSON.stringify({ body: 'plain body' }))).toBe('plain body');
    expect(parseMessageText(JSON.stringify({ eventCreate: { value: { x: { body: 'nested' } } } }))).toBe('nested');
  });
  it('returns empty on junk / missing', () => {
    expect(parseMessageText(undefined)).toBe('');
    expect(parseMessageText('not json')).toBe('');
    expect(parseMessageText(JSON.stringify({ nothing: 1 }))).toBe('');
  });
});

describe('isRecentConnectionsResponse / classifyAcceptedFromResponse', () => {
  const V = 'https://www.linkedin.com/voyager/api/';
  const url = `${V}relationships/dash/connections?count=40&sortType=RECENTLY_ADDED&start=0`;

  it('flags only the RECENTLY_ADDED connections endpoint', () => {
    expect(isRecentConnectionsResponse(url)).toBe(true);
    expect(isRecentConnectionsResponse(`${V}relationships/dash/connections?sortType=DISTANCE`)).toBe(false);
    expect(isRecentConnectionsResponse(`${V}relationships/invitations`)).toBe(false);
  });

  it('extracts every named profile, whatever the nesting, deduped by slug', () => {
    const body = JSON.stringify({
      elements: [{ connected: { publicIdentifier: 'ada-l', firstName: 'Ada', lastName: 'Lovelace' } }],
      included: [
        { publicIdentifier: 'ada-l', firstName: 'Ada', lastName: 'Lovelace' }, // dup slug
        { publicIdentifier: 'grace-h', name: 'Grace Hopper' },
      ],
    });
    const out = classifyAcceptedFromResponse(url, body);
    expect(out).toEqual([
      { slug: 'ada-l', name: 'Ada Lovelace' },
      { slug: 'grace-h', name: 'Grace Hopper' },
    ]);
  });

  it('is empty on the wrong endpoint, junk body, or a slug with no name', () => {
    expect(classifyAcceptedFromResponse(`${V}other`, '{}')).toEqual([]);
    expect(classifyAcceptedFromResponse(url, 'not json')).toEqual([]);
    expect(classifyAcceptedFromResponse(url, JSON.stringify({ publicIdentifier: 'x' }))).toEqual([]);
  });
});

describe('endpointOf', () => {
  it('strips host and query, keeps the path', () => {
    expect(endpointOf('https://www.linkedin.com/voyager/api/feed/x?count=10')).toBe('/voyager/api/feed/x');
  });
});

describe('pushNetLog', () => {
  it('appends and caps at NETLOG_MAX', () => {
    let ring: NetLogEntry[] = [];
    for (let i = 0; i < NETLOG_MAX + 25; i++) {
      ring = pushNetLog(ring, { atMs: i, method: 'GET', endpoint: `/x/${i}`, status: 200 });
    }
    expect(ring.length).toBe(NETLOG_MAX);
    expect(ring[ring.length - 1].endpoint).toBe(`/x/${NETLOG_MAX + 24}`);
  });
});

describe('acceptSeen', () => {
  it('remembers a slug within the TTL and forgets it after', () => {
    const t0 = 1_000_000;
    const m = acceptSeenPut({}, 'ada', t0);
    expect(acceptSeenHas(m, 'ada', t0 + 1000)).toBe(true);
    expect(acceptSeenHas(m, 'ada', t0 + ACCEPT_SEEN_TTL_MS + 1)).toBe(false);
    expect(acceptSeenHas(m, 'grace', t0)).toBe(false);
  });
  it('prunes expired entries as it adds', () => {
    const t0 = 0;
    const old = acceptSeenPut({}, 'old', t0);
    const next = acceptSeenPut(old, 'fresh', t0 + ACCEPT_SEEN_TTL_MS + 1);
    expect(Object.keys(next).sort()).toEqual(['fresh']);
  });
});
