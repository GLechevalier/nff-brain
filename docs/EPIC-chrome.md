# EPIC — nff-brain in the browser

**Status:** items 0–5 SHIPPED (2026-08-11) · item 6's assets written, store
submission is the remaining manual step (`packages/chrome/store/`) · item 7
SHIPPED (2026-08-12), pending only the manual LinkedIn-DOM verification row in
`packages/chrome/README.md` — selectors were written and unit-tested but never
run against a live results page
**Goal:** the browser stops being the one place where learning evaporates.
**Done when:** a fact you encountered in Chrome is recalled in a Claude Code
session without you having filed it anywhere. **The loop is closed:** the
SessionEnd hook (and `nff-brain clips --drain`) drains the queue into
`origin: 'clip'` nodes with their own recall budget, and recall injects them
as `[clip]` lines.

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
| Does `origin: 'clip'` get its own recall budget? | **RESOLVED (2026-08-11): its own protected budget.** Clip nodes are exempt from the 400 agent cap and from every merge/fold (the retraction invariant: `/v1/retract` deletes by origin, so a clip node must hold only clip content), capped at 60 by `pruneClips`, and recalled through their own `clipBudget: 3` slots — never the agent 12, never the whole-graph bypass. |
| Is item 4's output brain-shaped at all? | **RESOLVED (2026-08-11): yes, via the clip queue.** Recorder events ship as `kind: 'note'` clips with a `recorder-event <action>` first line — no fifth ClipKind — and the drain distills them like any capture. GitHub's output (issues/PRs you wrote) is exactly coding-recall-shaped; LinkedIn invites ride the same path, with CRM export still a possible follow-on. |

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

**Shipped 2026-08-11 as count + search + node list + Ask, deliberately with NO
graph drawing.** The acceptance line never required one, the webview renderer
is React and `bundlePurity` bans react-dom from dist, so shipping zero graph
UIs in the panel is how the two-graph-UIs risk was avoided rather than
incurred. If a panel graph is ever wanted: `packages/core/src/layout.ts`
already holds the browser-safe geometry — extract a framework-free SVG painter
both UIs wrap; do not port React.

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

## 7. Web agent

*New — the only item that writes on the user's behalf, and the only one that
knowingly crosses item 4's "observe-only, never automate" bright line.*

| | |
|---|---|
| **Scope** | A natural-language goal produces a plan the user approves once (`packages/chrome/agent/`), then the local server drives a LinkedIn content script through a narrow, fixed action vocabulary (`navigate`, `readResultCards`, `clickConnect` — never arbitrary DOM eval) up to a configurable cap, with server-authoritative randomized pacing and an always-visible Stop. Every real action lands in the existing clip pipeline via `deliverRecorderClip()`, and every matched person is written to a **user-registered, plug-and-play HTTP MCP server** (`nff-brain mcp add/list/remove/test`, `/v1/mcp/*`) — not a hardcoded CRM integration. |
| **Example** | "find robotics engineers at Series A startups on LinkedIn, connect, and add them to my CRM" → plan review → up to N connects, each logged and each triggering a `tools/call` on whichever MCP tool the user picked for that run. |
| **Acceptance** | Approve a plan capped at 3 → at most 3 Connect clicks happen, each with a randomized (never fixed-interval) 1–4 min delay, each produces a clip AND an MCP tool call, and Stop mid-run halts new actions within one poll cycle while letting an in-flight action finish. |
| **Depends on** | 0, 1, 4 (reuses the recorder's clip pipeline and the LinkedIn host-permission opt-in machinery) |
| **Package** | `packages/core` (`webAgent*.ts`, `mcpClient.ts`, `mcpServers.ts` — pure prompt/parse + the hand-rolled MCP client), `packages/cli` (`webAgentRun.ts` orchestration, `serve/agentRoutes.ts` + `serve/mcpRoutes.ts`, `commands/mcp.ts`), `packages/chrome` (`agentGate.ts`, `agentRegistry.ts`, `agentRunner.ts`, `content/linkedinAgent(Classify).ts`, `agent/`) |
| **Size** | XL — shipped |

**Four risks, priced and answered:**

1. **Recording ≠ scraping, but this is automation, not recording.** Item 4's
   defense ("capturing your own actions is defensible") does not extend here:
   an unattended click loop is exactly what LinkedIn's anti-automation systems
   and Chrome Web Store review are built to catch. **Decision: ships in the
   SAME listing as the recorder** (not a separate unlisted build) — a
   deliberate call, revisit if it draws review friction.
2. **Web Store review.** No new permissions were needed (`https://www.linkedin.com/*`
   and `scripting` were already granted for the item-4 recorder — `manifest.test.ts`
   required zero edits, which is itself the proof), but *what the code does*
   is a materially different risk profile than what item 4 was reviewed for.
3. **Selector rot**, same as item 4, now with a second content script
   (`content/linkedinAgent.ts`: read cards, click Connect) subject to the same
   DOM churn — and unlike the recorder's selectors, these have never been
   run against a live page (see the README checklist).
4. **Autonomous-action safety.** Priced by: a server-authoritative cap the
   extension cannot raise by asking twice (`WEB_AGENT_MAX_ACTIONS_CEILING`,
   clamped at plan-creation time, never model-controlled), a randomized 1–4
   min inter-action delay (the floor is `chrome.alarms`' own scheduling
   minimum for packaged extensions, not an arbitrary choice), and a Stop
   checked both server-side (`shouldGrantAction`) and client-side (the SW
   cancels its own `nb.agentPoll` alarm immediately).

**Design notes worth keeping visible:**

- **The planning "brain" is interim by design.** v1 shells to the user's own
  local `claude -p` (`runClaude()`/`makeOneShot()`, same as distill/merge) —
  no API key ever touches this codebase. Every call site takes `brain:
  OneShot` as a parameter rather than reaching for `runClaude()` directly, so
  a future web-hosted planning brain is a rebind of one parameter in
  `packages/cli/src/webAgentRun.ts`, not a rewrite of the prompt/parse logic.
- **The generic MCP client is reusable infrastructure beyond this item.** It's
  also the missing piece that would let a future revision of item 5's Ask
  panel *call* tools, not just retrieve nodes — item 5 shipped retrieval-only
  specifically to avoid this scope. `mcpClient.ts` is deliberately hand-rolled
  (raw JSON-RPC over `fetch`, stateless-Streamable-HTTP only) rather than
  `@modelcontextprotocol/sdk`, which would have cost the CLI its documented
  zero-runtime-dependency property for a ~16-package transitive tree it does
  not need.
- **One active run globally**, no `paused` phase (Stop is terminal), the
  judgment call (`evaluateCards`) batches one page of results per LLM call —
  deliberate v1 scope limits, not oversights; see `packages/cli/src/webAgentRun.ts`'s
  header comment and `WebAgentRun`'s phase doc-comment in
  `packages/core/src/webAgentTypes.ts` for the reasoning.

---

## Suggested order

```
0 → 1 → 2 → 6 → 3 → 5 → 4 → 7
```

- **0 first** — everything blocks on transport.
- **2 before 3** — S vs L, and item 2 is the only early item that actually puts
  new knowledge into the brain. Item 3 ships a viewer, not a capability.
- **6 in parallel** with 1 — review latency is not on your critical path if it
  starts early.
- **4 before 7** — item 7 reuses item 4's clip pipeline and permission
  machinery directly; building it first would mean duplicating both.
- **7 last** — XL, the only item with real ToS/automation exposure, and the
  one most worth having the recorder's patterns already proven before
  attempting.

---

## Open questions

- [ ] Native messaging vs localhost HTTP (item 0) — security vs one-click install
- [ ] Global brain by default, or force a project picker? (structural fact B)
- [ ] Direct write vs queue-drained-by-CLI (item 0)
- [ ] Does `origin: 'clip'` get its own recall budget, or share the agent cap?
- [x] Is item 4's output brain-shaped at all, or should it go straight to CRM?
      **RESOLVED by item 7:** neither exclusively — it stays a brain clip
      (audit trail) AND goes to whichever MCP tool the user configured
      (CRM or otherwise), via the generic `/v1/mcp/call` path.
- [ ] Item 7's "the list" is a free-text tag (`how_we_met`) on whatever object
      the configured MCP tool creates — no first-class list/tag object exists.
      Worth a dedicated concept if a second consumer of "the list" appears.
- [ ] Item 7 ships in the SAME Web Store listing as the recorder — revisit if
      LinkedIn's anti-automation systems or a review rejection ever makes that
      look like the wrong call in hindsight.
