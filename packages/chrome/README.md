# nff-brain — Chrome extension

Local-first memory for Claude Code, in the browser. Right-click any selected
text → **Remember this**, and it lands in a queue the next Claude Code session
distills into your brain. Two modes:

- **Paired** (preferred): the extension talks only to `nff-brain serve` on
  `127.0.0.1`. Nothing leaves your machine.
- **Standalone** (no CLI, no Claude Code): save your own AI API key on the
  options page and the brain lives in `chrome.storage.local` — captures
  distill on a background model via a direct provider call from the service
  worker, and the DevTools Brain tab chats over them with a stronger one. A
  stored pairing always wins; pairing later migrates the local brain into the
  server automatically (`POST /v1/import`).

The CSP enumerates exactly two reachable hosts (loopback + the shipped
provider's API); nothing is sent anywhere until you pair or save a key.

See `docs/docs.md` §13 for the transport, the clip queue, and the threat model.

## Develop

```
npm run build -w nff-brain-chrome      # → packages/chrome/dist
npm run watch -w nff-brain-chrome      # rebuild on save
npm run package -w nff-brain-chrome    # → packages/chrome/nff-brain-chrome.zip
```

`dist/` **is** the load-unpacked directory and **is** the contents of the store
zip (manifest at the archive root). Load it via `chrome://extensions` →
Developer mode → Load unpacked.

An unpacked build gets a random extension id, so pair it against a server
started with `--allow-origin chrome-extension://<that id>` if you have pinned
origins from an earlier pairing. After the first Web Store upload, add the
published `key` to `manifest.json` so unpacked and store builds share one id.

## Layout

| file | |
|---|---|
| `src/gate.ts` | **the capture choke point** — pure, zero imports, the security surface |
| `src/schema.ts` | the `chrome.storage.local` contract; no `chrome.*` |
| `src/health.ts` | backoff ladder, staleness, phase derivation; pure |
| `src/protocol.ts` | popup ⇄ worker messages **and** the `/v1` wire types |
| `src/storage.ts` | the only module that touches `chrome.storage` |
| `src/client.ts` | fetch wrapper; every URL it can build is loopback |
| `src/connection.ts` | probe / pair / unpair |
| `src/capture.ts` | the context menus (selection/link/page) → gate → `POST /v1/clip` |
| `src/recorder.ts` | SW side of the per-site recorders — the SECOND registered `shouldCapture` caller |
| `src/recorderRegistry.ts` / `recorderTypes.ts` / `recorderFormat.ts` | adapter metadata, wire validation, event formatting; all pure |
| `src/agentGate.ts` | **the agent's own choke point** (item 7) — pure, zero imports, a separate question from `shouldCapture()`: is DOM automation allowed here right now |
| `src/agentRegistry.ts` / `agentTypes.ts` | web-agent adapter metadata — mirrors the recorder registry, but a distinct opt-in |
| `src/agentRunner.ts` | SW side of the web agent: adapter enable/disable, the alarm-redriven poll loop, tab driving, dispatch to the LinkedIn content script; also the permission-prompt handlers for "navigate to X" (see `docs/navigate.md`) |
| `src/actionIntent.ts` / `src/navigateTool.ts` | "navigate to X" — the action-intent detector and the same-tab navigate primitive; see `docs/navigate.md` |
| `src/sw.ts` | listener registration only — read its header before editing |
| `popup/` | static skeleton + `paint(state)`; plain DOM, no framework |
| `devtools/` | the Brain panel (F12 → Brain), two tabs: **Brain** — one chat transcript with a Manual/Plan/Auto mode switch (Manual = LLM-synthesized chat over retrieved nodes; Plan/Auto = the item-7 web agent, with/without a review step) — and **MCP** — list/test/enable/disable/remove registered MCP servers, browser-mutable but never able to register a new one with a secret. Both tabs go through the worker, token never in the panel |
| `content/` | recorder + web-agent content scripts — no token, no fetch, no storage (CI-enforced); `linkedinAgent.ts` is the one exception that RECEIVES commands (`sendResponse` only, never `sendMessage`); `virtualCursor.ts` is the thin element-based wrapper over the shared overlay in `src/cursorScript.ts` — a brand-colored pointer + label the agent glides to a target right before it clicks, so a real click is never invisible. The same `cursorScript.ts` is injected via CDP by `src/actEngine.ts` so the full web agent (Act tab) draws the identical cursor |
| `src/mode.ts` | paired / standalone / unconfigured resolution — a stored pairing always wins |
| `src/providerClient.ts` | the ONLY module that sends a provider request (adapters are pure, in `@nff-brain/core/provider`); key read from storage at call time |
| `src/brainStore.ts` | the standalone brain's serialized write path (the second documented module-level variable) |
| `src/standaloneDrain.ts` | capture tail → `nb.clipQueue` → alarm-driven drain → local nodes; one atomic `commitDrain` |
| `src/standalone.ts` | local-brain siblings of getNodes/search/graph/chat/clear — same response shapes as serve |
| `src/migrate.ts` | standalone→paired migration, piggybacked on the healthy probe; idempotent |
| `options/` | the settings page (BYOK key, provider, two model slots); key never rendered back |
| `store/` | Web Store assets: privacy policy, permission justifications, listing copy, submission runbook |

Two invariants are enforced by `test/bundlePurity.test.ts` rather than by
memory: every capture decision goes through `shouldCapture()`, and the service
worker declares no mutable module-level state (MV3 kills it after ~30s idle, so
a module variable silently reverts to its initializer — the hardest MV3 bug to
reproduce).

`test/manifest.test.ts` pins the permission set. Widening it means editing that
file, which is a deliberate act with a review conversation attached.

## Manual verification

Automated tests cover the pure logic; the rest needs a browser. Prerequisite:
`nff-brain serve` running, `dist/` loaded unpacked.

| Criterion | Steps |
|---|---|
| **Local Network Access** — do this first | On the newest stable Chrome, fresh profile: pair. If the fetch fails with a local-network error, confirm the popup's Connect button triggers `chrome.permissions.request` and that granting it fixes the connection. **Record the Chrome version and outcome below.** |
| **Narrowest permissions** | Upload the zip as a Web Store draft; the computed list must be exactly storage + alarms + activeTab + contextMenus. Install the packed build in a clean profile and screenshot the install dialog — it must show **no** permission warnings. |
| **Local-first** | With NO provider key saved: open the service worker's own DevTools (`chrome://extensions` → *service worker*) → Network → clear. Run ≥5 min through several alarm ticks, open/close the popup 10×, add and remove domains, capture a clip. **Every request must be 127.0.0.1.** Repeat in the popup's DevTools. Then stop `serve`: the failures must be connection refusals, not DNS lookups — a DNS query is itself an off-device call. (With a key saved, the ONLY additional host ever contacted must be `api.anthropic.com`.) |
| **Connected + node count** | Popup green; counts match `nff-brain list`. Ctrl-C the server → badge red within one alarm tick. Restart → the popup opens green **immediately** (the forced probe, not the next tick). Corrupt the stored token → *Pairing expired*, and the worker log shows probing has **stopped**, not backed off. |
| **Pause halts capture within one page load** | Allowlist a domain, capture ON, right-click a selection → the clip lands (`nff-brain doctor` shows pending +1). Toggle to PAUSED. **Without reloading the page**, right-click again → nothing lands and the activity count is unchanged. |
| **Pause survives restart** | Set PAUSED. Quit Chrome entirely — verify no `chrome.exe` remains, or a background process keeps storage warm and invalidates the test. Relaunch → still PAUSED. **Then bump the version and reload the unpacked extension** so `onInstalled` fires with `reason: 'update'` → still PAUSED. That second half is what catches the default-reseeding bug. |
| **Service-worker death** | Confirm connected, leave idle ≥60s until `chrome://extensions` reports the worker *inactive*, reopen the popup → connected with the right counts, **without re-pairing**. Then force-terminate the worker from `chrome://extensions` and repeat. Any regression to "unpaired" means state leaked into a module variable. |
| **Default deny** | Empty allowlist, capture ON, unlisted site → right-click capture is a no-op. Add `*.example.com` → works on `example.com` and `a.example.com`. Confirm by hand once that `evilexample.com` still does nothing. |
| **Clear activity history** | With records buffered but **no drain yet run**: the dialog offers only "wipe the local buffer" and no checkbox. With an empty buffer the button is **disabled**. |
| **The loop (the epic's Done-when)** | Capture a selection (+ a link, + a page) → `nff-brain clips` lists them → `nff-brain clips --drain` → `brain.json` gains `origin:"clip"` nodes with `sourceUrl` → a new Claude Code session's preamble shows `[clip] …` lines. |
| **Clip→node feedback + retract** | After a drain, within ~1 min (the probe piggyback) the clear dialog shows "Also delete the N brain nodes…". Confirm with the box ticked → the nodes are gone from `brain.json` and `clip-map.jsonl` no longer names them. Kill `serve` and try again → an error, and the buffer is NOT cleared. |
| **DevTools Brain panel — header** | F12 anywhere → Brain tab: counts match `nff-brain list`. Hand-append a node to `brain.json` → count bumps ≤5 s without a reload. Inspect the panel document itself → Network: **zero requests** (everything rides the worker). Unpaired → the banner says to pair from the popup. |
| **Manual mode (chat)** | "what did I learn about oauth callbacks" → a prose answer appears in the transcript with source chips for the nodes it actually retrieved; a nonsense question → an honest "doesn't answer that" reply rather than padded generic advice. Confirm this is the only mode that costs a `claude -p` call — Plan/Auto submissions and the MCP tab must not trigger one. |
| **Plan mode** | Type a goal → a plan card appears in the transcript with Approve/Discard — nothing runs until Approve is clicked. Discard → the card shows "Discarded." and no run starts. |
| **Auto mode** | Type a goal → **no plan-review card appears at all**; the transcript goes straight to a live run card and polling starts immediately. |
| **Recorder enable/disable** | Enable the GitHub recorder → Chrome prompts for github.com ONLY; `github.com` appears in the allowlist. Disable → `chrome://extensions` → site access shows the permission is **gone**. |
| **Recorder events land** | With capture ON: open two issues and post one comment on GitHub → three `recorder-event` clips pending (`nff-brain clips`), titles and repos correct. Same on LinkedIn: send an invite → one event with the name (and note). Double-submit → still one event. |
| **Recorder respects pause + allowlist** | Toggle capture PAUSED → a recorder action lands nothing, without reloading the page. Remove `github.com` from the allowlist while the recorder is enabled → nothing lands, and the popup row shows "blocked". |
| **Recorder survives update** | Bump the version and reload the unpacked extension (`onInstalled` fires with `reason:'update'`, which CLEARS registered scripts) → the recorder still fires on the next action (the reconciliation re-registered it). |
| **Web agent — LinkedIn DOM (unverified, see docs/EPIC-chrome.md item 7)** | Register an MCP server (`nff-brain mcp add`), F12 → Brain tab → enable the LinkedIn agent adapter (Chrome prompts for `www.linkedin.com` — confirm it's a SEPARATE grant from the recorder's), switch to Plan or Auto mode, pick the registered server/tool as "add matches to", submit a small goal with `maxActions: 2`. Confirm: the SW opens/reuses one background tab and navigates it; `readResultCards` actually finds the visible people-search cards (this is where LinkedIn's real DOM will have rotted the selectors in `content/linkedinAgent.ts` if anything did); at most 2 Connect clicks fire, each with a **randomized, multi-minute** gap (never back-to-back); each produces a clip (`nff-brain clips`) AND a call to the configured MCP tool. |
| **Web agent — virtual cursor (unverified — new, live-page-only)** | During the same run as the row above, watch the background LinkedIn tab (switch to it, or drag it foreground) while a `clickConnect` action fires. Confirm: a brand-colored (`#00ffcc`) dot + "nff-brain agent" label glides from its previous position to the Connect button, pulses, then glides to the confirmation modal's Send button and pulses again, then fades out — and that it never intercepts the real click underneath it (the Connect/Send actions still succeed). After the shared-overlay refactor (`src/cursorScript.ts`), also confirm the overlay does NOT stack duplicate hosts across repeated actions and that it fades out at run end (the old closed-shadow-root bug did neither). |
| **Web agent — Act tab / CDP engine (unverified — new, BYOK, live-page-only)** | Set a provider key in Settings (BYOK). Open any ordinary http(s) page, F12 → **Act** tab, type a task ("read this page and click the first link"), Run. Confirm: Chrome prompts once for the `debugger` permission; the "…is debugging this browser" bar appears; an origin grant prompt (Once/Always/Never) shows for the site; after granting, a `#00ffcc` cursor visibly moves/clicks/types as the transcript streams actions; the action counter climbs toward the budget; **Stop** halts it and the bar disappears; clicking the bar's **Cancel** mid-run also ends the run. Password fields must never appear in the read_page transcript, and the agent must refuse to attempt a CAPTCHA. |
| **Web agent — Stop is immediate** | Mid-run, click Stop on the run card. Confirm no further Connect click ever fires (poll the SW's alarm via `chrome://extensions` → service worker → Application → the alarm should be cleared), and the one action already in flight (if any) still completes and records before the run shows `stopped`. |
| **Web agent — opt-in is separate from the recorder** | With the LinkedIn recorder OFF and the web agent ON (or vice versa), confirm each toggle is independent (popup's Recorders row vs. the Brain tab's own toggle) and that disabling the agent releases its own permission grant without touching the recorder's. |
| **MCP tab — list/test/enable/disable/remove** | A CLI-registered server (`nff-brain mcp add`) appears with a dot + name; Test populates a live tool count; Disable turns the dot grey and a subsequent Test still works (disabling doesn't revoke reachability, just eligibility as a list target); Remove drops it from the list and from `~/.nff-brain/mcp-servers.json`. Confirm no header/secret value is ever visible in the panel's DOM (inspect the elements, not just the visible text). |
| **MCP tab — cannot register a new server** | Confirm there is no form to add a server, only the copy-pasteable `nff-brain mcp add …` hint — registering a new one always requires the terminal. |
| **Graph tab** | F12 → Brain panel → Graph tab: nodes render as colored circles with edges between them, count matches `nff-brain list`. Scroll to zoom, drag to pan — confirm panning/zooming does NOT flicker or reset on the next ~5s poll tick. Hand-append a node to `brain.json` → it appears within one poll tick, and your current pan/zoom is preserved. |
| **Standalone — provider CORS (do FIRST, real key)** | NO serve running, no pairing. From the SW console run one `fetch('https://api.anthropic.com/v1/messages', {method:'POST', headers:{'content-type':'application/json','x-api-key':'<real key>','anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}, body: JSON.stringify({model:'claude-haiku-4-5',max_tokens:1,messages:[{role:'user',content:'ping'}]})})`. A 200 proves the CORS path from a `chrome-extension://` origin. **If it fails**: fall back to adding `https://api.anthropic.com/*` to `optional_host_permissions`, requested at key-save time. Record the Chrome version + outcome below. |
| **Standalone — key save + test** | Popup → Settings (opens a tab). Save a real key → field empties, "Key saved" renders, badge turns the standalone color. Test connection → green "key accepted". Enter a garbage key → Test shows "invalid API key". Clear → popup back to "Not paired". |
| **Standalone — the loop** | Key saved, capture ON, site allowlisted, NO serve: capture a selection → badge flashes +1, activity shows delivered. Within ~1 min (alarm tick) the note appears in the Graph tab and `getNodes` counts bump. Ask about it in the Brain tab → a prose answer with source chips. Plan/Auto buttons and the MCP tab must be hidden. |
| **Standalone — retract** | After a local drain: clear activity with "also remove nodes" ticked → nodes gone from the Graph tab. The checkbox must not render before the drain has produced nodes. |
| **Standalone — fail-open drain** | Save a garbage key, capture a clip → the clip stays queued (activity delivered, no node), Settings shows the failed last-test, and the SW console shows no retry storm (backoff ladder holds). Fix the key → the queued clip distills on a later tick without re-capturing. |
| **Standalone — SW kill mid-drain** | Queue a few clips, and from `chrome://serviceworker-internals` stop the worker right after a capture. Reopen → next alarm tick drains them; confirm NO duplicate nodes (the seen ring). |
| **Migration** | Build a small standalone brain (≥2 notes), then `nff-brain serve` + `nff-brain pair` and pair from the popup. The popup shows "moving N standalone notes…" then it clears; `nff-brain search` finds the migrated notes (origin `clip`); retract from the popup still deletes them server-side; the badge is the paired green and captures now POST to the server. Kill serve mid-migration → everything stays local and the next healthy probe finishes the job. |

### Local Network Access — findings

> Not yet run. Record Chrome version, whether the loopback fetch succeeded with
> no `host_permissions`, and whether the optional permission was needed.

## Known limitations

- **Wildcard rules do not consult a public suffix list.** `*.com` and
  `*.localhost` are rejected (fewer than two labels), but `*.co.uk` slips
  through. A full PSL is a megabyte of data and a dependency; neither belongs in
  a popup.
- **Ports are ignored in allowlist matching.** A rule for `example.com` matches
  any port. Users think in sites, and a per-port list creates the trap where the
  same site is captured on 443 but silently not on 8443.
- **"Also remove nodes" lights up only after a drain has run** and the ~1-min
  probe piggyback has fetched the clip→node map. Until then the popup shows no
  checkbox — honest, not broken.
- **Graph tab is read-only geometry, not a layout engine.** It renders
  whatever `x`/`y`/`size`/`color` are already stored on each node (via a
  plain inline SVG — no react-dom, `bundlePurity` still bans it) and never
  computes a layout itself. Nodes that predate a `nff-brain layout` run may
  cluster at the origin; re-run `nff-brain layout` for a clearer picture.
- **Recorder selectors rot.** GitHub detection is URL/form-shape-based and
  should be sturdy; LinkedIn leans on accessible labels and WILL need
  maintenance. The classifiers are pure (`test/recorder.test.ts`), so rot is a
  named test failure, not a silently dead recorder.
- **Incognito is not supported** (`"incognito": "not_allowed"`), deliberately: a
  memory tool silently recording incognito browsing is a landmine.
- **The web agent's LinkedIn selectors are the least-verified code in this
  package** (item 7). `content/linkedinAgent.ts` reads search-result cards and
  finds the Connect button by accessible label, same discipline as the
  recorder, but has never been run against a live results page — selector rot
  here is a broken run, not a missing clip. See the manual checklist above.
- **The web agent's MCP client supports only the stateless flavor of
  Streamable HTTP** (one JSON-RPC POST → one JSON or single-frame-SSE
  response). A server that requires a session handshake or a live SSE stream
  is out of scope for v1 and fails with a clear error from `nff-brain mcp
  test`, not a silent hang.
- **One active web-agent run globally**, not per-tab or per-goal — the browser
  has no workspace concept, so a second `agentSubmitGoal` while one is active
  is refused (409) until the first is stopped or finishes.
- **Manual-mode chat costs one `claude -p` call per message** — a deliberate
  reversal of items 5 and 7's original "retrieval-only, no LLM synthesis"
  stance, now explicitly requested. Plan/Auto goal submission and everything
  in the MCP tab stay free; only sending a Manual-mode message spends a call.
- **The MCP tab can mutate the server registry (enable/disable/remove) from
  the browser** — a deliberate, narrow widening of the trust boundary.
  Registering a *new* server (where a secret header/token would be entered)
  still requires `nff-brain mcp add` in a terminal; the panel only ever shows
  a copy-pasteable command for that, never a form.
- **Chat history is client-side and ephemeral** — a plain array in the panel
  document, same precedent as the old Ask tab's transcript. It does not
  survive closing DevTools, and it is never written to disk.
- **Standalone mode is lexical-only and clip-only.** Search/chat retrieval is
  `fuseRanked` (no semantic embeddings in the browser), every note is
  `origin:'clip'` capped at 200, and `recallBrain`'s preamble path is
  deliberately not ported — the surfaces are the popup, the Brain tab, and
  the Graph tab. Anthropic is the only shipped provider; OpenAI/Gemini are
  interface-ready (`@nff-brain/core/provider`) but greyed out in Settings.
- **Standalone drain quality depends on the background model** — a weaker
  model raises the parser's null rate; the queue never drops (fail-open +
  backoff), it just distills later or after a model change.
