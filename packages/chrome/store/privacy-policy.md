# nff-brain Chrome Extension — Privacy Policy

**Effective date:** 2026-08-11

nff-brain is a local-first memory tool for Claude Code. This extension's entire
purpose is to let you save snippets from your browser into a knowledge base
**that you run yourself, on your own machine**. It has no servers of ours, no
accounts, no analytics, and no way to send your data anywhere else.

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

Exclusively to `nff-brain serve`, a program **you** start on your own computer,
reachable only at `127.0.0.1` (your machine's loopback address). The extension's
Content Security Policy (`connect-src 'self' http://127.0.0.1:*`) makes it
technically impossible for it to contact any other host — this is enforced by
Chrome itself, not merely promised, and verified by the extension's automated
test suite. Zero data leaves your device. There are no analytics, no telemetry,
no crash reporting, and no remote code.

## What is stored locally in your browser

- The pairing token for your own local server (created when you type the
  pairing code; it never appears on screen).
- Your capture on/off flag and domain allowlist.
- A capped local activity history of recent captures, so you can review and
  delete them.

## Your controls

- **Pause** capture at any time from the popup; the pause holds immediately.
- **Default deny**: no domain is ever captured unless you added it.
- **Clear activity history** wipes the local buffer, and can also ask your local
  server to delete the notes created from those captures.
- Disabling a recorder also releases its site permission.
- Uninstalling the extension removes everything it stored in the browser.

## What we never do

- Sell, share, or transmit your data (we never possess it).
- Read pages, profiles, or content you did not explicitly act on.
- Run in incognito windows (`"incognito": "not_allowed"`).
- Load remote code.

## Changes and contact

Changes to this policy ship with the extension and are recorded in the
repository history. Questions: open an issue on the nff-brain repository, or
email gauthier.lechevalier26@gmail.com.
