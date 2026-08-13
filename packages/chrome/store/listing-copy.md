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

**Works standalone too.** No Claude Code? Add your own AI API key (Anthropic;
more providers coming) on the Settings page and the extension builds the
knowledge base right in your browser: captures distill into notes on a
background model, and the DevTools Brain tab answers questions from them with
a stronger one. Pair with a local server later and everything migrates over
automatically.

**Local-first, provably.** By default the extension can only talk to
`nff-brain serve`, a server you run yourself on 127.0.0.1. The Content
Security Policy enumerates exactly two reachable hosts — your loopback server
and the AI provider you may configure with your own key — and Chrome itself
blocks everything else. No accounts, no analytics, no telemetry, and nothing
is ever sent anywhere until you either pair a server or save a key.

**Private by default.**
- Capture is OFF until you switch it on.
- No site is captured unless you added it to your allowlist (default deny).
- Pause takes effect immediately; clearing your history can also delete the
  notes it created.
- Incognito is not supported, deliberately.

**Best with** the free `nff-brain` CLI (`npm install -g nff-brain`), running
`nff-brain serve` — pair once with a 6-digit code and your captures feed the
same brain your Claude Code sessions recall. Or skip the CLI entirely and use
your own API key.

Built for people who use Claude Code and want their agent to stop forgetting
what they already learned.

## Screenshots

See `screenshots.md`.

## Privacy policy URL

Served from the repository (see `submission-checklist.md` — record the final
URL there once GitHub Pages / the rendered link is set up).
