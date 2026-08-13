# "Navigate to X" — how it works

Two independent mechanisms in the Chrome extension can open a page for you
from the Brain tab's chat/prompt box. They look similar from the outside but
fire under different conditions and are implemented completely separately.
This doc covers both, plus the one shared design decision that shapes both:
**never open a new tab** — always navigate the tab DevTools is already
inspecting, so the F12 panel driving the request stays attached to it.

## 1. The action-intent shortcut (the common case)

This is what fires for a short, direct request like "navigate to linkedin" or
"open developer.chrome.com". It is a **local heuristic, not an LLM call** — it
costs nothing extra on every ordinary chat message, and it runs entirely in
`devtools/panel.ts` before anything is sent anywhere.

```
type in prompt box
        │
        ▼
detectActionIntent(message)   ← packages/chrome/src/actionIntent.ts, pure
        │
   ┌────┴─────┐
   │          │
 null      ActionIntent
   │          │
   ▼          ▼
ordinary   submitActionIntent()
  chat       │
             ▼
      Manual/Plan mode          Auto mode, or already
      → show Yes/No/Never-      "never ask again"-ed
        ask-again prompt        → navigate immediately,
                                   no prompt
```

### Detecting intent

`detectActionIntent()` requires **both** an action verb (`navigate`, `go to`,
`open`, `visit`, `take me to`) **and** a recognizable site, checked in two
tiers:

1. **Registered adapter** (today: just LinkedIn, `AGENT_ADAPTERS` in
   `agentRegistry.ts`) — its alias (`linkedin`, from `www.linkedin.com`) must
   appear in the message. This is the same adapter model the LinkedIn
   DOM-automation agent (Plan/Auto mode) uses, so it's checked first and
   returns `{ kind: 'adapter', adapterId, label, url }`.
2. **Generic fallback**, for any other site — no adapter registration needed.
   After stripping the verb (+ optional "to"), the **entire remainder of the
   message** must collapse to exactly one token (once trailing filler like
   "please"/"now"/"for me" and punctuation are stripped) that matches a
   plausible hostname shape. A token with a dot is used as a literal domain
   (`developer.chrome.com` → itself); a bare word gets `.com` appended
   (`google` → `google.com`). Returns `{ kind: 'host', host, label, url }`.

The single-remaining-token requirement is the whole ballgame: it's what lets
`"navigate to google"` resolve to `google.com` while `"open the pod bay
doors"` (remainder: four words) or `"navigate to the settings page"`
(remainder: three words) correctly fall through to ordinary chat instead of
firing a bogus prompt. Both are pinned as regression tests in
`packages/chrome/test/actionIntent.test.ts`.

**Safety property**: the detector only ever reads the user's own raw typed
message — never chat history, retrieved brain notes, or an LLM's reply. A
hostile brain note can't steer where this navigates; the only risk surface is
the false-positive rate on ordinary sentences, which the single-token
constraint above is what controls.

### Asking permission (or not)

The permission prompt (Yes / No / "Never ask again") is the same UI
regardless of which tier matched — `panelPaint.ts`'s `permissionEntryEl()`
renders purely off `label`/`url`, so it's tier-agnostic. What differs is
*resolution*, which is keyed by a `target` discriminant on the transcript
entry:

| | adapter target | host target |
|---|---|---|
| "never ask again" storage | `agentActionAllow` (adapter id ⇒ allowed), `nb.agentActionAllow` | `navigateHostAllow` (host ⇒ allowed), `nb.navigateHostAllow` |
| set via | `setAgentActionAllowed` message → `agentRunner.ts` | `setNavigateHostAllowed` message → `agentRunner.ts` |
| navigate via | `runAdapterNavigate` message | `runNavigateHost` message |

Both storages are separate, host/adapter-id-keyed maps in
`chrome.storage.local` (via `storage.ts`, the only module allowed to touch
it) — deliberately a **sibling** of the adapter enable/disable state
(`agentAdapters`/`AgentAdapterState`), not a repurposing of it: "the
autonomous LinkedIn DOM agent is enabled" and "silently open a tab for this
site without asking" are different questions, so disabling one never touches
the other.

**Mode changes when the prompt is skipped, not whether it CAN be**:

- **Manual / Plan mode**: always asks, unless the target is already on its
  allow-list.
- **Auto mode**: never asks — same "no review step" contract Auto mode
  already has for a generated goal-plan. If the target is genuinely new (not
  yet always-allowed), the transcript entry still lands with `decision:
  'yes'` (a one-time grant, not persisted) so there's a visible record of
  what happened; "always allowed" entries land with `decision: 'always'`.

## 2. The BYOK chat's `navigate` tool (a different, LLM-driven path)

The standalone/BYOK chat (bring-your-own Anthropic key, no `nff-brain serve`
pairing) additionally has a real Anthropic tool-use loop
(`providerClient.ts`'s `runChatWithTools`) with one tool:
`navigateTool.ts`'s `navigate`. This fires only when:

- `detectActionIntent` found nothing (the action-intent shortcut always runs
  first and short-circuits before any chat call), **and**
- the extension is in standalone/BYOK mode (an Anthropic key is saved, no
  `serve` pairing) — the *paired* Manual-mode chat calls a bare `claude -p`
  subprocess server-side with no tool-calling at all, so this path never
  applies there.

Here the **model itself** decides whether to call `navigate` and with what
URL, based on the conversation — useful for a request phrased less directly
("pull up the fetch API docs for me") that the mechanical single-token
detector above wouldn't catch. There is currently **no permission prompt** on
this path — a tool call just executes. `MAX_CHAT_TOOL_TURNS` (3) bounds how
many tool round-trips one chat turn can take.

## 3. Staying on the same tab

Both mechanisms end up calling the same primitive:
`navigateTool.ts`'s `executeNavigate(input, tabId)`:

```ts
await chrome.tabs.update(tabId, { url });      // navigate IN PLACE
// falls back to chrome.tabs.create() only if that tab is gone
```

`tabId` is always `chrome.devtools.inspectedWindow.tabId` — only available in
`panel.ts` (a DevTools extension page), threaded through the SW message
(`runAdapterNavigate`/`runNavigateHost`/`chatAsk` all carry `tabId`) down to
wherever the actual navigation happens. This is deliberate: `chrome.tabs.create`
opens a tab with no DevTools attached, which would strand the F12 panel that
the request came from. `agentRunner.ts`'s **other** `navigate` verb (the
Plan/Auto autonomous LinkedIn agent's own background tab, `ensureAgentTab`) is
the one exception — it intentionally opens/reuses its own `active: false`
background tab across a whole automated run, since an unattended agent
navigating the user's current tab out from under them would be worse.

## Known limitations

- **The generic fallback's `.com` guess is blunt.** `weather` → `weather.com`
  happens to be right; a site whose real TLD isn't `.com` (`.org`, `.io`,
  country codes, …) won't resolve unless typed with the dot already
  (`wikipedia.org`). No dictionary of well-known brand→TLD mappings is
  maintained — deliberately, to avoid a second, harder-to-audit source of
  "what does this word mean" alongside the adapter registry.
- **Multi-word site names never match the generic fallback**, by design (the
  single-token requirement is the false-positive guard). "navigate to new
  york times" won't fire; "navigate to nytimes.com" will.
- **The BYOK tool-call path has no confirmation UI.** Unlike the action-intent
  shortcut, a model-initiated `navigate` tool call executes immediately.
- **LinkedIn's adapter path and the generic host path are genuinely separate
  storages/messages**, not just cosmetically — merging them was considered
  and rejected to avoid touching the already-verified LinkedIn flow while
  adding the generic one.

## Key files

| file | role |
|---|---|
| `packages/chrome/src/actionIntent.ts` | the pure detector (both tiers) — zero `chrome.*` imports, fully unit-tested |
| `packages/chrome/src/agentRegistry.ts` | the adapter list the "tier 1" match consults (today: LinkedIn only) |
| `packages/chrome/src/navigateTool.ts` | `validateNavigateUrl`, `executeNavigate` — the one place that actually calls `chrome.tabs.*` for navigation |
| `packages/chrome/src/agentRunner.ts` | SW-side handlers for both the adapter (`runAdapterNavigate`/`setAgentActionAllowed`) and generic host (`runNavigateHost`/`setNavigateHostAllowed`) permission flows |
| `packages/chrome/src/providerClient.ts` | `runChatWithTools` — the BYOK tool-call loop |
| `packages/chrome/devtools/panel.ts` | `submitActionIntent`/`resolvePermission` — where mode (Manual/Plan/Auto) and "never ask again" state are checked |
| `packages/chrome/devtools/panelPaint.ts` | the permission-prompt UI (`permissionEntryEl`) |
| `packages/chrome/src/protocol.ts` | the message types: `runAdapterNavigate`, `setAgentActionAllowed`, `runNavigateHost`, `setNavigateHostAllowed`, `chatAsk` (all `tabId`-carrying) |
| `packages/chrome/test/actionIntent.test.ts` | the detector's regression tests, including the false-positive guards |
