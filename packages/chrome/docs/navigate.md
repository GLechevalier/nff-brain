# "navigate to X" — the Manual-mode action-intent shortcut

Referenced from `README.md`'s layout table (`src/agentRunner.ts`,
`src/actionIntent.ts` / `src/navigateTool.ts`) but never written until now.
This covers what actually ships today, not the aspirational item-7 web agent
— see `CLAUDE.md` for how this fits alongside the other three subsystems.

## What it is

A cheap, local, **regex-only** heuristic that lets the side panel's chat
input open a page (or move through browser history) without spending an LLM
call. It runs on every submitted message, in every chat mode (Manual / Plan
/ Auto), *before* the message is handed to the mode's normal pipeline —
`sidepanel/main.ts:submitPrompt()`:

```ts
const intent = detectActionIntent(message);
if (intent) await submitActionIntent(intent);
else if (mode === 'manual') await submitChat(message);
else await submitGoal(message);
```

If `detectActionIntent()` (`src/actionIntent.ts`) returns non-null, the
message never reaches `chatAsk`/`agentSubmitGoal` at all.

## Detection: `detectActionIntent()`

Four checks, in order, each pure string/regex work — zero `chrome.*`
imports, testable without a browser (`test/actionIntent.test.ts`):

1. **History first, independent of everything else.** `extractHistoryDirection()`
   matches `go|navigate|head|take me` + `back|forward`, with an optional
   trailing `"(to) (the) previous/last/next page"` and/or a filler
   sign-off. Examples: `"go back"`, `"navigate back to the previous page"`,
   `"take me back"`, `"go forward"`. The **entire remainder** after the
   direction word must collapse to nothing, or it's rejected — `"go back to
   work on the report"` leaves `"to work on the report"` and correctly falls
   through instead of triggering a false-positive back-navigation.
2. **Verb gate.** If the message contains none of `navigate`, `go to`,
   `open`, `visit`, `take me to`, bail out (`null`).
3. **Registered adapter alias.** Loop over `AGENT_ADAPTERS` (today, just
   LinkedIn); if the message mentions an adapter's alias ("linkedin"),
   return that adapter's fixed URL — this wins over the generic guess below
   because that site may also have real DOM automation behind it.
4. **Generic single-token site guess** — `extractGenericSite()`. Requires
   the *entire* remainder after the verb (once noise is stripped) to
   collapse to exactly one hostname-shaped token:
   - Strip a leading article (`a`/`an`/`the`) — `"navigate to a reddit"` → `"reddit"`.
   - Strip trailing filler/sign-offs (`please`/`pls`/`plz`/`now`/`for
     me`/`thanks`/`thank you`/`ok`/`okay`/`asap`), looping until nothing
     more strips — `"google now please"` → `"google"`.
   - What's left must be a single word matching `HOSTNAME_RE`. Two or more
     words (`"open the pod bay doors"` → `"pod bay doors"`) is rejected —
     this is what stops an ordinary sentence merely containing "open"/"visit"
     from being misread as navigation.
   - A dot in the token is used as a literal domain (`developer.chrome.com`
     stays as-is); no dot gets `.com` appended (`"google"` → `google.com`).

`ActionIntent` is one of:
```ts
| { kind: 'adapter'; adapterId: string; label: string; url: string }
| { kind: 'host'; host: string; label: string; url: string }
| { kind: 'history'; direction: 'back' | 'forward' }
```

## Execution: `submitActionIntent()`

`sidepanel/main.ts:submitActionIntent()` branches on `intent.kind`:

- **`history`** — always executes immediately, in every mode, with no
  permission prompt. Sends `{ type: 'runNavigateHistory', direction, tabId }`
  to the service worker → `agentRunner.ts:runNavigateHistory()` →
  `chrome.tabs.goBack(tabId)` / `chrome.tabs.goForward(tabId)` (the same
  calls the CDP web agent's `nav.back`/`nav.forward` verbs use in
  `actEngine.ts`, where that verb kind is classified auto-granted — no
  per-origin prompt). Errors (no history entry to go to) surface as a field
  error; success pushes a plain `'answer'` transcript entry ("← Went back" /
  "→ Went forward").
- **`adapter` / `host`** — checked against a stored allowlist
  (`agentActionAllow` / `navigateHostAllow`). If always-allowed, or the
  current mode is `auto`, it navigates immediately
  (`runAdapterNavigate`/`runNavigateHost` → same-tab `chrome.tabs.update`,
  falling back to a new tab if that tab is gone) and logs a resolved
  `'permission'` transcript entry. Otherwise it pushes an *unresolved*
  `'permission'` entry with Yes/No/Never-ask-again buttons
  (`render.ts`'s `permissionEntryEl`) and waits for the user.

This is also why Manual and Plan modes "ask" for a site navigation but Auto
doesn't, and why history navigation never asks in any mode — going back/
forward acts only on the current tab's own history, not a new origin.

## The other navigate primitive: BYOK chat's `navigate` tool

`src/navigateTool.ts` is a *separate* code path: the one browser-control
tool exposed to the LLM in standalone/BYOK Manual-mode chat
(`NAVIGATE_TOOL_SPEC`, wired via `runChatWithTools` in
`standalone.ts`). It only supports opening a URL (`chrome.tabs.update`,
same-tab-first/new-tab-fallback) — **no back/forward action** — and only
ever runs when `detectActionIntent()` found nothing and the message reached
the LLM. In paired mode, `chatRoutes.ts` has no tool-calling at all, so an
undetected navigation-shaped message there just gets answered from brain
notes (the original bug this doc exists to prevent recurring: an
unrecognized phrasing silently falling through to a confused chat answer
instead of navigating).

## Known gaps

- The generic single-token rule is deliberately narrow. Anything with more
  than one content word after stripping articles/filler (`"open the
  settings page"`, `"go to my bank account"`) is rejected by design, not a
  bug — it falls through to chat instead.
- `navigateTool.ts` (BYOK chat's LLM tool) doesn't yet mirror the fast
  path's `back`/`forward` support the way the CDP web agent's `actTools.ts`
  `navigate` tool spec already does. In practice this rarely matters since
  `extractHistoryDirection()` catches the common phrasings before the
  message ever reaches chat — but an unusual back/forward phrasing that
  slips past the heuristic will currently get the same "I can't do that"
  reply from BYOK Manual chat that this doc's history-nav work was written
  to eliminate for the fast path.
