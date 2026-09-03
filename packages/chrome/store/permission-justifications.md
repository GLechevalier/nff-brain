# Permission justifications (Chrome Web Store dashboard)

Paste-ready paragraphs for the "Privacy practices" tab. One per permission.
These mirror the comments in `test/manifest.test.ts`, which pins the set — the
dashboard answers and the manifest can never drift apart silently.

## v0.1.0 (initial submission)

### `storage`

Stores the user's pairing token for their own local server, the capture on/off
flag, the domain allowlist, and a capped local history of recent captures. In
the optional bring-your-own-key mode it also stores the user's own AI API key,
their model choices, queued captures, and the in-browser knowledge base built
from them. All of this must survive service-worker termination and browser
restarts; MV3 service workers are killed after ~30 seconds of idle, so
in-memory state is not an option.

### `alarms`

A once-per-minute heartbeat that checks whether the user's local `nff-brain
serve` process is still reachable and updates the toolbar badge. A `setInterval`
dies with the MV3 service worker; an alarm is the only reliable scheduler.

### `activeTab`

Used solely so the popup can offer an "Allow this site (current host)" button
when the user opens it. The extension reads the current tab's hostname at that
moment and nothing else; it does not use the `tabs` permission and cannot
enumerate or read other tabs.

### `contextMenus`

The product's core verb: right-click → "Remember this" on a selection, link, or
page. Without it the extension has no capture mechanism.

### `debugger`

Required (Chrome forbids `debugger` in `optional_permissions`, so it cannot be
requested at runtime — it must be declared here). It powers the web-agent "Act"
feature: when the user types a task in the DevTools panel's Act tab and clicks
Run, the extension attaches the Chrome DevTools Protocol to the one tab the user
is looking at, to move a visible cursor, click, type, and scroll on their behalf
toward the task they described. The extension NEVER attaches on its own — only
after the user starts a run — and it attaches to just that one tab. The agent
uses the user's own bring-your-own-key AI provider; nothing is sent to us. While
attached, Chrome shows its standard "nff-brain is debugging this browser" bar —
by design, so the user can always see the agent and stop it (the bar's Cancel
detaches us and ends the run, as does the panel's Stop button). The extension
never attaches to browser-internal pages, the Web Store, or `file://` URLs, and
detaches as soon as the run ends. Passwords and payment fields are never read
into what the model sees, and the agent is instructed never to solve CAPTCHAs.
This is the one install-time permission warning the extension carries.

### `tabs`

Required by the same web-agent "Act" feature. The agent acts on the tab the
user has open in DevTools; the service worker must read that tab's URL to refuse
browser-internal pages (`chrome://`, the Web Store, `file://`) and to ask the
user's permission per site before acting. Without `tabs`, the URL of a tab the
extension holds no host grant for is hidden, so the agent cannot tell a normal
page from a restricted one. It accompanies `debugger` and exposes strictly less
(page URLs/titles) than the debugger attachment it gates. Used only for the Act
feature; the passive recorder and clipping never read other tabs.

### `optional_host_permissions: http://127.0.0.1/*`

Declared but NOT requested at install. The extension talks to a server the user
runs on their own machine at 127.0.0.1. If a future Chrome version's
local-network-access rules require an explicit grant for loopback fetches, the
extension will request this permission at pairing time — only then, and only
for loopback. It never requests access to any real website.

### Single-purpose statement

nff-brain captures notes the user explicitly selects in their browser into a
personal knowledge base — either a local, user-run memory server (127.0.0.1)
recalled in the user's Claude Code sessions, or, only if the user adds their
own AI API key, a knowledge base kept inside the browser. By default nothing
leaves the user's machine; with a user-supplied key, captures go only to that
user's own AI provider account (CSP-enumerated, one host).

### Data-usage certification answers

- Collects "Website content": **yes** — only text/links the user explicitly
  right-clicks to save.
- Transmitted off the user's device: **only** to the AI provider the user
  explicitly configures with their own API key, at the user's request; never
  by default and never to us (the CSP enumerates loopback + that one provider
  host and nothing else).
- Sold to third parties: **no**. Used for unrelated purposes: **no**.
- Used for creditworthiness/lending: **no**.

## v0.2.x (recorder update — submit ONLY with the recorder release)

### `scripting`

Registers a content script on a site **only after** the user enables that
site's recorder in the popup and grants its host permission through Chrome's
own prompt. Dynamic registration (`chrome.scripting.registerContentScripts`)
keeps the manifest free of static content scripts: sites where recorders are
not enabled never run any extension code.

### `optional_host_permissions: https://github.com/*`

For the GitHub recorder (per-site opt-in, off by default): records the titles
of issues/PRs/comments **the user themself submits** on GitHub, as notes in
their local memory. Requested only when the user flips the GitHub recorder on;
removed again when they turn it off. The content script observes only the
user's own form submissions — it does not read repositories, profiles, or any
page content the user did not act on.

### `optional_host_permissions: https://www.linkedin.com/*`

For the LinkedIn recorder (per-site opt-in, off by default): records who the
user sent a connection invite to, when, and the note attached — the user's own
outbound actions only, saved as notes in their local memory. Requested only
when the user enables the LinkedIn recorder; removed on disable. The content
script never reads profiles, feeds, or messages, and never automates any
action.

## v0.3.x (passive page-visit capture — submit ONLY with this release)

### `optional_host_permissions: http://*/*` and `https://*/*`

Back a new, per-domain opt-in feature: when the user adds a domain to their
capture allowlist (Settings tab, same allowlist that already gates the
right-click "Remember this" verbs and the recorders above), the extension also
reads a short excerpt of each allowlisted page's own text — title, headings,
and main body, not the full page HTML — when the user navigates to it, so that
content can become a note in their personal knowledge base alongside their
explicit captures. Both patterns are declared but requested **only** for the
single narrow origin the user just added (e.g. `https://docs.example.com/*`),
in the same click that adds the allowlist rule — Chrome requires the runtime
request to be a subset of a *declared* optional pattern, and since any domain
the user types is allowed, the declared pattern must be broad even though the
actual grant per click is not. Declining the prompt does not block adding the
domain: explicit "Remember this" keeps working there either way, and passive
reading on that domain simply stays off. Removing the domain from the
allowlist releases the permission again. This never runs via `chrome.debugger`
— it uses `chrome.scripting.executeScript`, so it carries no additional
install-time warning and shows none of the "being debugged" UI the Act feature
does. Gated by the same capture on/off switch as everything else in this
document, and by a daily cap on how many visited pages actually get turned
into notes (excess pages simply wait for the next day) — so the feature cannot
run away with API cost or storage even on a heavy browsing day.

### Data-usage certification answers (updated)

- Collects "Website content": **yes** — text/links the user explicitly
  right-clicks to save, AND (new, opt-in per domain) a short excerpt of pages
  the user visits on a domain they added to their allowlist and granted
  browsing access to.
- Everything else in the v0.1.0 answers above is unchanged: nothing is sold,
  nothing is transmitted except to the AI provider the user configured with
  their own key, and nothing is used for lending/creditworthiness.
