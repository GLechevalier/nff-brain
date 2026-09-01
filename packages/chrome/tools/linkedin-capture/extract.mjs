// Extract LinkedIn "network transfers" from a capture file.
//
//   node extract.mjs <file>                       # catalog + extracted records
//   node extract.mjs <file> --samples             # + full sample bodies to eyeball shapes
//   node extract.mjs <file> --post <secret>       # POST accepts+messages to the CRM
//        [--base https://admin.nanoforgeflow.com]
//
// <file> is EITHER a .har (Chrome DevTools "Export HAR") OR the .txt (JSONL)
// from tracker.js — the format is auto-detected. Node 18+ (global fetch).
//
// The classifiers below mirror packages/chrome/src/inviteNet.ts on purpose:
// whatever we learn here about real payload shapes gets folded back into that
// file so the shipped extension and this tool agree.

import { readFileSync } from 'node:fs';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!file) {
  console.error('usage: node extract.mjs <capture.har|capture.txt> [--samples] [--post <secret>] [--base <url>]');
  process.exit(1);
}
const BASE = val('--base') || 'https://admin.nanoforgeflow.com';
const SECRET = val('--post');

// ── load + normalize to {method,url,status,reqBody,resBody} ──────────────────
function load(path) {
  const raw = readFileSync(path, 'utf8');
  // HAR?
  try {
    const j = JSON.parse(raw);
    if (j && j.log && Array.isArray(j.log.entries)) {
      return j.log.entries.map((e) => {
        const c = e.response?.content || {};
        let resBody = c.text || '';
        if (c.encoding === 'base64' && resBody) {
          try {
            resBody = Buffer.from(resBody, 'base64').toString('utf8');
          } catch {
            /* leave as-is */
          }
        }
        return {
          method: (e.request?.method || 'GET').toUpperCase(),
          url: e.request?.url || '',
          status: e.response?.status || 0,
          reqBody: e.request?.postData?.text || '',
          resBody,
        };
      });
    }
  } catch {
    /* not HAR — fall through to JSONL */
  }
  // JSONL (tracker.js)
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        const e = JSON.parse(l);
        return { method: (e.method || 'GET').toUpperCase(), url: e.url || '', status: e.status || 0, reqBody: e.reqBody || '', resBody: e.resBody || '' };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const VOYAGER = 'https://www.linkedin.com/voyager/api/';
const all = load(file);
const voyager = all.filter((e) => e.url.startsWith(VOYAGER));

// ── classifiers (mirror src/inviteNet.ts) ───────────────────────────────────
const isInvite = (e) =>
  e.method === 'POST' &&
  e.status >= 200 &&
  e.status < 300 &&
  /invitation/i.test(e.url) &&
  !/withdraw|accept|ignore|reject|closeInvitations|invitationsSummary|seenReceived/i.test(e.url);

const isMessageSend = (e) => e.method === 'POST' && /messaging|messenger/i.test(e.url) && /createMessage|messengerMessages|\/events\b|messagesbyanchor/i.test(e.url);

const isRecentConnections = (e) => /connections/i.test(e.url) && /RECENTLY_ADDED/i.test(e.url);

function parseMessageText(body) {
  if (!body) return '';
  let root;
  try {
    root = JSON.parse(body);
  } catch {
    return '';
  }
  const seen = new Set();
  const walk = (v) => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return '';
    seen.add(v);
    const b = v.body;
    if (typeof b === 'string' && b.trim()) return b.trim();
    if (b && typeof b === 'object' && typeof b.text === 'string' && b.text.trim()) return b.text.trim();
    for (const val of Object.values(v)) {
      const f = walk(val);
      if (f) return f;
    }
    return '';
  };
  return walk(root).slice(0, 2000);
}

function acceptedFrom(body) {
  if (!body) return [];
  let root;
  try {
    root = JSON.parse(body);
  } catch {
    return [];
  }
  const out = new Map();
  const seen = new Set();
  const walk = (v) => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return void v.forEach(walk);
    const slug = typeof v.publicIdentifier === 'string' ? v.publicIdentifier : '';
    if (slug) {
      const name = [v.firstName, v.lastName].filter(Boolean).join(' ').trim() || (typeof v.name === 'string' ? v.name.trim() : '');
      if (name && !out.has(slug)) out.set(slug, name.slice(0, 80));
    }
    for (const val of Object.values(v)) walk(val);
  };
  walk(root);
  return [...out].map(([slug, name]) => ({ slug, name }));
}

// ── catalog ──────────────────────────────────────────────────────────────────
const mask = (url) =>
  url
    .replace(VOYAGER, '/')
    .split('?')[0]
    .replace(/urn%3Ali%3A[^/]+/gi, 'urn')
    .replace(/\d{5,}/g, '#');
const catalog = new Map();
for (const e of voyager) {
  const k = `${e.method} ${mask(e.url)}`;
  catalog.set(k, (catalog.get(k) || 0) + 1);
}
console.log(`\n=== ${voyager.length} voyager calls / ${all.length} total, ${catalog.size} distinct endpoints ===`);
[...catalog].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

// ── extracted records ────────────────────────────────────────────────────────
const invites = voyager.filter(isInvite);
const messages = voyager.filter(isMessageSend);
const acceptCalls = voyager.filter(isRecentConnections);
const accepts = new Map();
for (const e of acceptCalls) for (const a of acceptedFrom(e.resBody)) accepts.set(a.slug, a.name);

console.log(`\n=== extracted ===`);
console.log(`invites sent:      ${invites.length}`);
console.log(`messages sent:     ${messages.length}`);
console.log(`accepts (people):  ${accepts.size}  (from ${acceptCalls.length} RECENTLY_ADDED responses)`);
for (const m of messages) console.log(`  message: "${parseMessageText(m.reqBody).slice(0, 80)}"  @ ${mask(m.url)}`);
for (const [slug, name] of accepts) console.log(`  accepted: ${name}  (${slug})`);

// ── samples (shape discovery) ────────────────────────────────────────────────
if (has('--samples')) {
  const show = (label, e, which) => {
    console.log(`\n--- ${label} :: ${e.method} ${mask(e.url)} ---`);
    const body = which === 'req' ? e.reqBody : e.resBody;
    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 4000));
    } catch {
      console.log((body || '(empty)').slice(0, 2000));
    }
  };
  if (messages[0]) show('MESSAGE request body', messages[0], 'req');
  if (acceptCalls[0]) show('RECENTLY_ADDED response body', acceptCalls[0], 'res');
  if (invites[0]) show('INVITE request body', invites[0], 'req');
}

// ── optional: POST to the CRM ────────────────────────────────────────────────
if (SECRET) {
  const post = async (kind, name, linkedin, body) => {
    const res = await fetch(`${BASE}/api/crm/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-ingest-token': SECRET },
      body: JSON.stringify({ kind, name, linkedin, body, occurred_at: new Date().toISOString() }),
    });
    console.log(`  POST ${kind} ${name} -> ${res.status}`);
  };
  const run = async () => {
    console.log(`\n=== posting to ${BASE}/api/crm/events ===`);
    for (const [slug, name] of accepts) await post('invite_accepted', name, `https://www.linkedin.com/in/${slug}`, 'Accepted your connection request');
    // Messages need a recipient — see the note below; skipped until the capture
    // reveals which call carries the recipient's slug/name (correlated by urn).
    console.log(`(messages not posted — recipient identity is not in the send body; see README)`);
  };
  run().catch((e) => console.error(e));
}
