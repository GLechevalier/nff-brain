# Web Store listing copy

## Name

nff-brain

## Short description (≤132 chars)

Local-first memory for Claude Code. Right-click to remember anything — it goes
only to a brain you run on your own machine.

(129 chars — recount after any edit.)

## Category

Developer Tools

## Long description

The browser is where learning evaporates: you read the doc, close the tab, and
next week your coding agent rediscovers it from scratch. nff-brain closes that
loop.

Right-click any selection, link, or page → **Remember this**. The capture lands
in a queue on YOUR machine, and the next time a Claude Code session ends, it is
distilled into a knowledge node your future sessions recall automatically — no
filing, no tags, no notes app.

**Nothing leaves your machine.** The extension can only talk to `nff-brain
serve`, a server you run yourself on 127.0.0.1. That is enforced by the
extension's Content Security Policy — Chrome itself blocks any other network
call. No accounts, no analytics, no telemetry.

**Private by default.**
- Capture is OFF until you switch it on.
- No site is captured unless you added it to your allowlist (default deny).
- Pause takes effect immediately; clearing your history can also delete the
  notes it created.
- Incognito is not supported, deliberately.

**Requires** the free `nff-brain` CLI (`npm install -g nff-brain`), running
`nff-brain serve`. Pair once with a 6-digit code; done.

Built for people who use Claude Code and want their agent to stop forgetting
what they already learned.

## Screenshots

See `screenshots.md`.

## Privacy policy URL

Served from the repository (see `submission-checklist.md` — record the final
URL there once GitHub Pages / the rendered link is set up).
