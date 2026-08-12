# EPIC — nff-brain in the browser

**Status:** items 0 and 1 SHIPPED (incl. item 2's capture verb) · 3, 4, 5, 6 open
**Goal:** the browser stops being the one place where learning evaporates.
**Done when:** a fact you encountered in Chrome is recalled in a Claude Code
session without you having filed it anywhere.

---

## What shipped

`nff-brain serve` + `nff-brain pair` (`packages/cli/src/serve/`,
`packages/core/src/serve*.ts`, `clip*.ts`) and the MV3 extension
(`packages/chrome`), including the right-click capture verb pulled forward from
item 2. Reference documentation is `docs/docs.md` §13; the manual verification
checklist is `packages/chrome/README.md`.

**Why the capture verb moved into item 1.** Three of item 1's six acceptance
criteria — start/pause, domain allowlist, clear history — govern a capture path
that did not exist, so half the acceptance table would have passed *because the
feature was absent*: a green ON toggle over a no-op. It also left the extension
with no user-observable behaviour at all, which is a live Chrome Web Store
minimum-functionality rejection risk, and item 6's review latency is on the
critical path. Adding `contextMenus` + one `onClicked` handler + `POST /v1/clip`
made all six criteria mechanically testable and cost no install warning.

**Item 2 is now about clip QUALITY**, not about capture existing: `link` and
`page` contexts, title extraction, dedupe, and the `origin: 'clip'` recall
budget.

**Still not verified:** Local Network Access against current Chrome (see the
Risks section of `packages/chrome/README.md`), and every row of that README's
manual checklist. Nothing yet mints brain nodes from clips — the queue fills,
and draining it is item 2.

### Open questions, resolved

| Question | Resolution |
|---|---|
| Native messaging vs localhost HTTP | **localhost HTTP.** A native-messaging host manifest must name an absolute launcher path in a per-OS registry/directory, which `npm i -g` cannot write, and it breaks one-click Web Store install. |
| Global brain by default, or force a project picker? | **Global by default**, `"target":"project"` per request. The browser has no workspace concept; global is merged into every recall, so a global clip is never invisible while a mis-filed project clip is. No picker. |
| Direct write vs queue-drained-by-CLI | **Queue.** Not for corruption (`mutateBrain` already locks) but because a clip must be distilled before it is a node, and "no LLM at click time" requires a holding area. |
| Does `origin: 'clip'` get its own recall budget? | **Still open** — deferred to item 2, which is where clips first become nodes. |
| Is item 4's output brain-shaped at all? | **Still open.** |

---

## Two structural facts that price everything below

### A. There is a blocking prerequisite

A Chrome extension **cannot read `.nff-brain/brain.json`** — extensions have no
filesystem access. Every item in this epic depends on a transport that does not
exist yet. That is item 0, and nothing else starts before it.

### B. Chrome has no concept of a workspace

nff-brain is per-project (`<workspace>/.nff-brain/brain.json`) with a global
fallback (`~/.nff-brain/brain.json`); recall merges both, project winning. The
browser doesn't know what project you're in — a LinkedIn tab isn't "in"
anything.

**Decision needed at item 0:** browser captures default to the **global brain**,
with an optional project override in the popup. Decide once, or every later item
inherits the ambiguity.

### Positioning guardrail

nff-brain's edge over verb-based memory systems (gbrain et al.) is *"no verb to
call"* — capture happens whether or not you thought of it. Several items below
(2, 5) are explicitly manual. They ship as **escape hatches, not the headline**.
If manual capture becomes the primary path, the product loses its distinction.

---

## 0. Transport & pairing — *blocking*

| | |
|---|---|
| **Scope** | `nff-brain serve` (localhost HTTP) + one-time pairing token. Extension stores the token; all calls authenticated and origin-checked. |
| **Acceptance** | Extension reads node count from a running brain. A malicious page on any other origin cannot. |
| **Depends on** | — |
| **Package** | `packages/cli` (new `serve` command) — this is core work, not extension work |
| **Size** | M |

**Risks**

- localhost is probe-able by any webpage. Token + `Origin` / `Sec-Fetch-Site`
  checks are mandatory, not nice-to-have.
- Native messaging is the more secure alternative, but requires a per-OS host
  manifest install — which breaks one-click Web Store install (bullet 1 of the
  MVP). Tradeoff must be made deliberately.

**Also decide here — the write path.** Does the extension write to the brain
directly, or append to a queue the CLI drains? Recommend **the queue**: single
writer, no risk of corrupting `brain.json` under concurrent writes.

---

## 1. Chrome extension MVP

| Sub-item | Acceptance |
|---|---|
| Web Store installable | Passes review with the narrowest permission set that works |
| Local-first | Zero network calls off-device; verifiable in the Network tab |
| Connect to local Brain | Popup shows connected / disconnected + node count |
| Start / pause | Pause halts all capture within one page load; survives browser restart |
| Domain allowlist | Default **deny** — nothing captured on a domain not explicitly added |
| Clear activity history | Wipes local buffer *and* offers to remove nodes created from it |

**Depends on** 0 · **Size** L

**Risk:** MV3 service workers are killed after ~30s idle. Anything stateful must
live in `chrome.storage` or an offscreen document — never a module-level
variable.

---

## 2. Right-click → "Remember this"

*Originally listed as #3. Recommended to ship second — see sequencing.*

| | |
|---|---|
| **Scope** | `contextMenus` on `selection`, `link`, `page`. Captures raw text + URL + timestamp into the queue. |
| **Acceptance** | Right-click a doc paragraph → it appears in the next session's recall preamble. |
| **Depends on** | 0, 1 |
| **Size** | S — genuinely small once transport exists |

**Two design decisions**

- **No LLM at click time.** A `claude -p` per right-click is slow and undermines
  the cost story. Queue raw; let the existing `SessionEnd` distill fold it in.
  Instant and free, and it reuses machinery that already exists.
- **Its own origin and quota** (`origin: 'clip'`). Agent nodes cap at 400 with a
  12-node recall budget. Unbudgeted clippings will crowd out the expensive
  session lessons (the `⚠ SessionEnd needs timeout: 120` class of node — the
  crown jewels). `origin: 'graphify'` is the existing precedent for a protected
  class that is never folded or evicted.

**Naming:** prefer "Remember this" over "Add this to context" — the latter is
ambiguous between *persist to the brain* and *inject into a running session*
(a much harder feature requiring a live channel to an open Claude Code process).

---

## 3. DevTools "Brain" panel

*Originally listed as #2.*

| | |
|---|---|
| **Scope** | `devtools_page` registering a Brain panel beside Console / Network. Live graph + node list + search. |
| **Acceptance** | F12 → Brain → see current node count and search it, updating live as nodes are added. |
| **Depends on** | 0 |
| **Size** | L |

**Risk:** duplicates the VS Code graph view. Extract the SVG renderer into a
shared package *before* building this, or two graph UIs get maintained forever.
The existing renderer is pure inline SVG with no chart libraries, which is what
makes the port feasible at all.

The port is the cost here — panel registration itself is trivial.

---

## 4. Always-on page recorders

*The largest item, and the only one carrying non-engineering risk.*

| | |
|---|---|
| **Scope** | Per-domain "always record" mode. A content script observes a declared set of *actions* on allowlisted domains and queues structured events. |
| **Example** | LinkedIn: record who you sent invites to, when, and the note attached. |
| **Acceptance** | Send three invites → three contact events land in the brain with names and timestamps. |
| **Depends on** | 0, 1 (the allowlist *is* the safety boundary) |
| **Size** | XL, and **per-site** — every domain is its own adapter |

**Three risks to price before starting**

1. **Recording ≠ scraping, but reviewers may not distinguish.** Capturing your
   own actions on your own screen is defensible. LinkedIn's User Agreement is
   aggressive about automation and their anti-bot systems more so. Recording
   what *you did* is far safer than reading profiles you didn't open — keep that
   line bright and explicit in the design.
2. **Web Store review.** "Record everything on a page" plus broad host
   permissions draws elevated scrutiny and slow reviews. Per-domain opt-in with
   narrow `host_permissions` is both better design and a faster review.
3. **Selector rot.** LinkedIn's DOM changes without notice. Every adapter is
   permanent maintenance. Build one, measure the real cost, then decide about a
   second.

**Downstream opportunity:** nff-admin already exposes CRM write tools
(`crm_create_contact`, `crm_log_interaction`). LinkedIn invite capture → CRM
contact is a strong follow-on, and arguably a better home for that data than the
brain, which is tuned for recall-into-coding-sessions.

---

## 5. Chat in the DevTools panel

| | |
|---|---|
| **Scope** | Ask questions of the brain from the Brain panel; answers cite nodes. |
| **Acceptance** | "what did I learn about OAuth callbacks" returns nodes with links. |
| **Depends on** | 0, 3 |
| **Size** | M |

**Risks**

- This is where gbrain's `synthesize` lives, and where it is strongest.
- It is the first nff-brain feature that *costs tokens to use* — awkward under a
  "less token burn" headline.

**Retrieval-only** (ranked nodes, no LLM synthesis) sidesteps both objections and
delivers most of the value. Recommended starting point.

---

## 6. Web Store release

*New — and it gates item 1.*

Privacy policy, permission justifications, screenshots, listing copy, review
cycle. Not engineering, still blocking. Start **in parallel with item 1**, not
after: first-time review can be slow, and "installable from the Chrome Web
Store" is bullet one of the MVP.

---

## Suggested order

```
0 → 1 → 2 → 6 → 3 → 5 → 4
```

- **0 first** — everything blocks on transport.
- **2 before 3** — S vs L, and item 2 is the only early item that actually puts
  new knowledge into the brain. Item 3 ships a viewer, not a capability.
- **6 in parallel** with 1 — review latency is not on your critical path if it
  starts early.
- **4 last** — XL, per-site, permanent maintenance, and the only item with
  third-party ToS exposure.

---

## Open questions

- [ ] Native messaging vs localhost HTTP (item 0) — security vs one-click install
- [ ] Global brain by default, or force a project picker? (structural fact B)
- [ ] Direct write vs queue-drained-by-CLI (item 0)
- [ ] Does `origin: 'clip'` get its own recall budget, or share the agent cap?
- [ ] Is item 4's output brain-shaped at all, or should it go straight to CRM?
