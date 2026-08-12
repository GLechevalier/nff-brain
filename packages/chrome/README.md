# nff-brain — Chrome extension

Local-first memory for Claude Code, in the browser. Right-click any selected
text → **Remember this**, and it lands in a queue the next Claude Code session
distills into your brain. Nothing leaves your machine: the extension talks only
to `nff-brain serve` on `127.0.0.1`.

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
| `src/sw.ts` | listener registration only — read its header before editing |
| `popup/` | static skeleton + `paint(state)`; plain DOM, no framework |
| `devtools/` | the Brain panel (F12 → Brain): counts + search + retrieval-only Ask; all HTTP via the worker, token never in the panel |
| `content/` | recorder content scripts — no token, no fetch, no storage (CI-enforced); they message the worker |
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
| **Local-first** | Open the service worker's own DevTools (`chrome://extensions` → *service worker*) → Network → clear. Run ≥5 min through several alarm ticks, open/close the popup 10×, add and remove domains, capture a clip. **Every request must be 127.0.0.1.** Repeat in the popup's DevTools. Then stop `serve`: the failures must be connection refusals, not DNS lookups — a DNS query is itself an off-device call. |
| **Connected + node count** | Popup green; counts match `nff-brain list`. Ctrl-C the server → badge red within one alarm tick. Restart → the popup opens green **immediately** (the forced probe, not the next tick). Corrupt the stored token → *Pairing expired*, and the worker log shows probing has **stopped**, not backed off. |
| **Pause halts capture within one page load** | Allowlist a domain, capture ON, right-click a selection → the clip lands (`nff-brain doctor` shows pending +1). Toggle to PAUSED. **Without reloading the page**, right-click again → nothing lands and the activity count is unchanged. |
| **Pause survives restart** | Set PAUSED. Quit Chrome entirely — verify no `chrome.exe` remains, or a background process keeps storage warm and invalidates the test. Relaunch → still PAUSED. **Then bump the version and reload the unpacked extension** so `onInstalled` fires with `reason: 'update'` → still PAUSED. That second half is what catches the default-reseeding bug. |
| **Service-worker death** | Confirm connected, leave idle ≥60s until `chrome://extensions` reports the worker *inactive*, reopen the popup → connected with the right counts, **without re-pairing**. Then force-terminate the worker from `chrome://extensions` and repeat. Any regression to "unpaired" means state leaked into a module variable. |
| **Default deny** | Empty allowlist, capture ON, unlisted site → right-click capture is a no-op. Add `*.example.com` → works on `example.com` and `a.example.com`. Confirm by hand once that `evilexample.com` still does nothing. |
| **Clear activity history** | With records buffered but **no drain yet run**: the dialog offers only "wipe the local buffer" and no checkbox. With an empty buffer the button is **disabled**. |
| **The loop (the epic's Done-when)** | Capture a selection (+ a link, + a page) → `nff-brain clips` lists them → `nff-brain clips --drain` → `brain.json` gains `origin:"clip"` nodes with `sourceUrl` → a new Claude Code session's preamble shows `[clip] …` lines. |
| **Clip→node feedback + retract** | After a drain, within ~1 min (the probe piggyback) the clear dialog shows "Also delete the N brain nodes…". Confirm with the box ticked → the nodes are gone from `brain.json` and `clip-map.jsonl` no longer names them. Kill `serve` and try again → an error, and the buffer is NOT cleared. |
| **DevTools Brain panel** | F12 anywhere → Brain tab: counts match `nff-brain list`. Hand-append a node to `brain.json` → count bumps ≤5 s without a reload; with a matching search active, the new node appears in the results. Inspect the panel document itself → Network: **zero requests** (everything rides the worker). Unpaired → the banner says to pair from the popup. |
| **Ask tab** | "what did I learn about oauth callbacks" → an answer card citing nodes with related links; a nonsense query → the honest empty answer; the retrieval-only disclaimer is visible. |
| **Recorder enable/disable** | Enable the GitHub recorder → Chrome prompts for github.com ONLY; `github.com` appears in the allowlist. Disable → `chrome://extensions` → site access shows the permission is **gone**. |
| **Recorder events land** | With capture ON: open two issues and post one comment on GitHub → three `recorder-event` clips pending (`nff-brain clips`), titles and repos correct. Same on LinkedIn: send an invite → one event with the name (and note). Double-submit → still one event. |
| **Recorder respects pause + allowlist** | Toggle capture PAUSED → a recorder action lands nothing, without reloading the page. Remove `github.com` from the allowlist while the recorder is enabled → nothing lands, and the popup row shows "blocked". |
| **Recorder survives update** | Bump the version and reload the unpacked extension (`onInstalled` fires with `reason:'update'`, which CLEARS registered scripts) → the recorder still fires on the next action (the reconciliation re-registered it). |

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
- **No graph drawing in the Brain panel** (deliberate): the acceptance needed
  count + search, and porting the React webview renderer is banned by
  `bundlePurity` (no react-dom in dist). If ever wanted, extract a
  framework-free SVG painter around `@nff-brain/core/layout` — do not port.
- **Recorder selectors rot.** GitHub detection is URL/form-shape-based and
  should be sturdy; LinkedIn leans on accessible labels and WILL need
  maintenance. The classifiers are pure (`test/recorder.test.ts`), so rot is a
  named test failure, not a silently dead recorder.
- **Incognito is not supported** (`"incognito": "not_allowed"`), deliberately: a
  memory tool silently recording incognito browsing is a landmine.
