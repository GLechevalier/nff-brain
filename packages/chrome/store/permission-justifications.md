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
