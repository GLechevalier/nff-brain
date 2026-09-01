# LinkedIn network capture → extract

A two-step discovery tool: capture LinkedIn's real Voyager API traffic to a
file, then extract the "network transfers" we want to record (invites you send,
who accepted you, messages you send). Its real job is to reveal the **actual
payload shapes** so the shipped extension's classifiers (`../../src/inviteNet.ts`)
are built on real data, not guesses.

## 1. Capture

Two ways — either produces a file you hand back:

- **Chrome DevTools (no code):** F12 → Network tab → do the actions → right-click
  the request list → **"Save all as HAR with content"**. That `.har` has every
  request and response body.
- **The console tracker (`tracker.js`):** open linkedin.com → F12 → Console →
  paste all of `tracker.js` → do the actions → run `nffDump()` to download a
  `.txt`. It captures only `voyager/api/*`, nothing else.

To make the capture useful, in one session: send 2–3 invites, open your
**"Recently added" connections** list, and send 2–3 messages.

## 2. Extract

```bash
node extract.mjs <capture.har|capture.txt>            # catalog + extracted records
node extract.mjs <capture.har|capture.txt> --samples  # + full sample bodies
node extract.mjs <capture.har|capture.txt> --post <CRM_INGEST_SECRET>
```

Format is auto-detected. `--samples` pretty-prints a full message request body, a
RECENTLY_ADDED response body, and an invite body — the shapes I need to see.
`--post` sends the extracted accepts to `admin.nanoforgeflow.com/api/crm/events`
(needs migration `0148` applied first).

## Open question this capture resolves

**Who a message was sent to is NOT in the send request** — the createMessage body
carries an opaque conversation/member URN, not a name or `/in/` slug. The shipped
extension works around this by scraping the open thread's DOM, which is fragile.
A real capture lets us find which *other* voyager call (a conversation or
participants fetch) names the recipient with a `publicIdentifier`, so we can
correlate by URN and attribute messages reliably — offline here, and then in the
extension. Until that's known, `--post` sends accepts only.

## Note

Throwaway dev tool — not bundled into the extension (lives outside `src/`,
`content/`, `sidepanel/`, so no build/test picks it up). Whatever shapes the
capture reveals get folded back into `src/inviteNet.ts`.
