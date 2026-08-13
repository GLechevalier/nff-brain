# nff-brain Chrome Extension — Privacy Policy

**Effective date:** 2026-08-12

nff-brain is a local-first memory tool for Claude Code. This extension's entire
purpose is to let you save snippets from your browser into a knowledge base
**that you run yourself, on your own machine** — or, only if you choose to add
your own AI API key, into a knowledge base kept inside your browser. It has no
servers of ours, no accounts, and no analytics.

## What the extension collects

Only what you explicitly capture:

- Text you select and right-click → **Remember this**.
- The URL and title of a link or page you right-click → **Remember this link /
  page**.
- If you enable a per-site recorder (off by default, per-domain opt-in), a
  structured note about actions **you yourself perform** on that site (for
  example, the title of an issue you just opened). Recorders never read pages
  you did not act on.

Nothing is captured unless capture is switched **on** (it is off after install)
**and** the site is on your allowlist (which starts empty — default deny).

## Where captured data goes

By default, exclusively to `nff-brain serve`, a program **you** start on your
own computer, reachable only at `127.0.0.1` (your machine's loopback address).
The extension's Content Security Policy (`connect-src 'self'
http://127.0.0.1:* https://api.anthropic.com`) restricts it to exactly two
destinations — your own loopback server, and the one AI provider endpoint used
by the optional bring-your-own-key mode below. This is enforced by Chrome
itself, not merely promised, and verified by the extension's automated test
suite. There are no analytics, no telemetry, no crash reporting, and no remote
code.

## Optional: bring your own AI key (standalone mode)

If you are **not** running a local server, you may paste your own Anthropic API
key on the extension's Settings page. This is entirely optional and **off by
default** — without a key (and without a paired server) captures simply queue
on your device and nothing is sent anywhere.

When you save a key:

- Your captured snippets, and excerpts of the notes already in your in-browser
  knowledge base, are sent **directly to `api.anthropic.com`** under your own
  account, solely to distill captures into notes and to answer questions you
  ask in the DevTools panel. They go nowhere else — we never see them.
- The key is stored only in the extension's local browser storage, is never
  displayed back (not even partially), never leaves the service worker except
  in requests to that provider, and is removed by the **Clear** button or by
  uninstalling.
- Your provider's own privacy terms apply to those requests (for Anthropic:
  their API terms). Anthropic states API inputs are not used to train models
  by default.

If you later pair with a local server, the notes built in your browser are
moved into your own local brain and standalone mode ends.

## What is stored locally in your browser

- The pairing token for your own local server (created when you type the
  pairing code; it never appears on screen).
- Your capture on/off flag and domain allowlist.
- A capped local activity history of recent captures, so you can review and
  delete them.
- In standalone mode: your API key, your model choices, the queued captures,
  and the in-browser knowledge base built from them (capped at 200 notes).

## Your controls

- **Pause** capture at any time from the popup; the pause holds immediately.
- **Default deny**: no domain is ever captured unless you added it.
- **Clear activity history** wipes the local buffer, and can also ask your local
  server to delete the notes created from those captures.
- Disabling a recorder also releases its site permission.
- Uninstalling the extension removes everything it stored in the browser.

## What we never do

- Sell, share, or transmit your data to us or to anyone you did not configure
  (we never possess it).
- Read pages, profiles, or content you did not explicitly act on.
- Run in incognito windows (`"incognito": "not_allowed"`).
- Load remote code.

## Changes and contact

Changes to this policy ship with the extension and are recorded in the
repository history. Questions: open an issue on the nff-brain repository, or
email gauthier.lechevalier26@gmail.com.
