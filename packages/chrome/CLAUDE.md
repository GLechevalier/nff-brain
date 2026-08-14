# nff-brain Chrome extension

MV3 extension that is the browser front-end to **nff-brain**, a local-first
knowledge graph ("the brain"). It captures notes you select, answers questions
from the brain, and runs a **web agent** that drives a real browser tab with a
visible cursor — either to do a one-off task you describe or to replay a
**recorded, generalized workflow**.

Everything real happens in the **service worker** (the only place that holds the
pairing token and makes network calls). Every UI surface (DevTools panel,
side panel, options, content scripts) is a *blind* client that messages the SW
and renders what it gets back.

---

## The two brains (this drives everything)

The extension runs in one of two modes, decided by whether a **pairing** is
stored (`nb.pairing`). A stored pairing ALWAYS wins (`src/mode.ts`):

- **Paired** — the brain is a local `nff-brain serve` process on
  `127.0.0.1:7373`. The extension is a thin HTTP client (`src/client.ts`); the
  brain, LLM calls (`claude -p` via the user's Claude Code login), and web-agent
  reasoning all live server-side. No API key needed.
- **Standalone / BYOK** — no server. The brain lives in `chrome.storage.local`
  (`nb.brain`), and LLM calls go straight to the user's own Anthropic key
  (`src/providerClient.ts`). Handlers mirror the paired routes 1:1
  (`src/standalone.ts`) so the UI is mode-agnostic.

`connect-src` in the CSP is pinned to loopback + `api.anthropic.com` — the only
two hosts the extension may ever reach.

---

## MV3 discipline (why the code looks the way it does)

The SW is killed after ~30s idle and recreated cold. Two hard rules, both
CI-enforced by `test/bundlePurity.test.ts`:

1. **No mutable module-level state in SW modules.** State lives in
   `chrome.storage.local`, read at the moment of use. Exactly four documented
   exceptions, each a serialization chain that is *harmless to lose* on worker
   death: `connection.ts` (`inFlightProbe`), `brainStore.ts`, `actStore.ts`,
   `traceCapture.ts` (`appendChain`).
2. **Every listener is registered synchronously at the top level of `sw.ts`** —
   a listener added after an `await` is missed on cold start.

`chrome.storage` is touched by **exactly one module**: `src/storage.ts`.

---

## Subsystems

### 1. Passive recorder — "Remember this"
Right-click → capture a selection/link/page as a **clip** (raw text, not yet a
node). Per-site, off by default, gated by an allowlist. A background drain
distills clips into brain nodes via an LLM.

### 2. Manual/Plan/Auto chat + LinkedIn agent (the *original* web agent)
The DevTools **Brain tab**: chat with the brain, or (Plan/Auto) give a goal that
drives a **narrow, fixed** LinkedIn content script (`navigate` / `readResultCards`
/ `clickConnect`) with server-authoritative pacing. This is the pre-existing,
LinkedIn-only agent — kept working, unchanged.

### 3. General web agent (CDP) — the Side Panel
The full-capability agent. Hosted in a **side panel** (not DevTools: Chrome
allows one debugger per tab and open DevTools holds that slot, so the panel must
be somewhere that leaves the active tab's slot free). It attaches `chrome.debugger`
to the window's **active tab** and drives it with trusted CDP input — click (all
buttons/counts), drag, scroll, type, keys, navigate — reading the page as a
token-lean element snapshot. A shared teal cursor overlay shows every action.
The reasoning loop runs through paired `claude -p` (default) or the BYOK
Anthropic tool-use API.

### 4. Record & automate
Record what you do on a tab → distill it into a **generalized workflow**
(literals become parameters, repeated blocks become one loop step) → store it as
a single brain node (`origin: 'workflow'`) → replay it later through subsystem 3,
re-grounding each step against the live page.

---

## Message routing

Three deliberately separate channels (`src/protocol.ts` holds the unions):

- **panel / side panel → SW**: `chrome.runtime.sendMessage`, union
  `PopupToSw` → reply `SwToPopup` (the union keeps its original name; the
  toolbar popup that named it is gone — the side panel is the only surface
  left speaking it, opened directly via `chrome.sidePanel.setPanelBehavior`).
  Dispatched in `sw.ts handleMessage()`. In standalone mode
  `handleStandaloneMessage()` intercepts first.
- **SW → content script**: `chrome.tabs.sendMessage` (the LinkedIn agent's two
  verbs). Closed union `SwToContent`.
- **content script → SW**: fire-and-forget `chrome.runtime.sendMessage`, and
  ONLY from `content/runtime.ts`, with type `recorderEvent` (passive recorder)
  or `traceEvent` (task recorder). No content script holds a token, fetches, or
  touches storage — CI-enforced.

The CDP web agent's loop is a held-open async chain in the SW; UI surfaces poll
`getActStatus` and render from `nb.actRun`.

---

## File map — where each thing lives

### Entry points & UI (`build.mjs` bundles each)
| Path | What |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: storage, alarms, activeTab, contextMenus, scripting, **debugger**, **tabs**, **sidePanel**. `debugger`/`tabs` carry the only install warnings (the web agent). |
| `src/sw.ts` | **Service worker entry.** Listener registration + `handleMessage()` dispatch. |
| `devtools/` | The **Brain / MCP / Graph** DevTools panel (subsystem 2 + brain browsing). `devtools.ts` registers the panel; `panel.ts` logic, `panelPaint.ts` pure renderers, `panel.html/css`. |
| `sidepanel/` | The consolidated UI (Setup · Agent · MCP · Brain · Graph · Settings) — this is now also the toolbar icon's default click target (no more separate popup; see `chrome.sidePanel.setPanelBehavior` in `src/sw.ts`). Setup carries what the old popup owned: pairing, capture toggle, allowlist, recorders, **Record a task**. `main.ts` targets the active tab + drives the run; `render.ts` pure renderers; `sidepanel.html/css`. |
| `options/` | BYOK key + model entry (a full tab, not a popup). `main.ts`, `options.html/css`. |

### Core plumbing
| Path | What |
|---|---|
| `src/schema.ts` | THE persisted contract — every `nb.*` storage key and its type. |
| `src/storage.ts` | The ONLY module that touches `chrome.storage`. Getters/setters per key. |
| `src/protocol.ts` | Message unions (`PopupToSw`/`SwToPopup`/`SwToContent`), `PublicState`, ports/timeouts. |
| `src/client.ts` | Paired-mode HTTP client — every `/v1/*` call, bearer token, pairing proof. |
| `src/connection.ts` | probe / pair / unpair orchestration + phase derivation. |
| `src/health.ts` | Pure connection-health arithmetic (backoff, phase). |
| `src/badge.ts` | Toolbar icon state. |
| `src/mode.ts` | Which brain is live (paired always wins). |

### Standalone / BYOK brain
| Path | What |
|---|---|
| `src/providerClient.ts` | The ONLY place a provider request is sent. `makeProviderOneShot`, `runChatWithTools` (the generic tool-use loop). |
| `src/brainStore.ts` | The in-browser brain's serialized write path (`mutateLocalBrain`, `runExclusive`). |
| `src/standalone.ts` | Standalone message handlers mirroring the paired serve routes. |
| `src/standaloneDrain.ts` | Clip queue → alarm drain → provider → nodes (browser side). |
| `src/migrate.ts` | Standalone→paired migration (push local brain into the server on pairing). |

### Passive recorder / capture (subsystem 1)
| Path | What |
|---|---|
| `src/capture.ts` | Context-menu "Remember this" verbs. |
| `src/gate.ts` | `shouldCapture(url, state)` — THE capture choke point (allowlist). |
| `src/activity.ts` | The local activity buffer (`nb.activity`) + clip→node feedback. |
| `src/recorder.ts` | Dynamic content-script (un)registration, clip delivery (`deliverRecorderClip`). |
| `src/recorderRegistry.ts` / `recorderTypes.ts` / `recorderFormat.ts` | Adapter metadata, contracts, event→clip formatting. |
| `content/github.ts` + `githubClassify.ts`, `content/linkedin.ts` + `linkedinClassify.ts` | Per-site passive observers (capture-phase listeners). |
| `content/runtime.ts` | Shared content-script emit (`emit` → `recorderEvent`, `emitTrace` → `traceEvent`). The one content→SW wire. |

### LinkedIn web agent (subsystem 2)
| Path | What |
|---|---|
| `src/agentRunner.ts` | SW poll loop (`pollAgent`, alarm-redriven) that drives the LinkedIn content script. |
| `src/agentGate.ts` | `shouldRunAgentAction` — that agent's own choke point (separate from `gate.ts`). |
| `src/agentRegistry.ts` / `agentTypes.ts` | Adapter registry + types. |
| `src/actionIntent.ts` | Manual-chat "navigate to X" heuristic. |
| `src/navigateTool.ts` | The chat's one browser tool (BYOK `ToolSpec` + `chrome.tabs.update`). |
| `content/linkedinAgent.ts` + `linkedinAgentClassify.ts` | Reads result cards, clicks Connect (the two verbs). |
| `content/virtualCursor.ts` | Thin element-based wrapper over the shared cursor overlay. |

### General web agent — CDP (subsystem 3)
The stable action/perception contract lives in **`@nff-brain/core`**
(`browserVerbs.ts`, `pageSnapshot.ts`). The extension side:
| Path | What |
|---|---|
| `src/cdp.ts` | Typed `chrome.debugger` wrapper (attach/detach/send/evaluate). |
| `src/actEngine.ts` | `executeVerb(tabId, verb)` — turns a validated `BrowserVerb` into real CDP input; drives the cursor before each interact. |
| `src/actPlan.ts` | Pure planners: key table, modifier bits, drag interpolation. |
| `src/snapshotScript.ts` | The self-contained page-reader injected via CDP (returns the element snapshot; refs stashed page-side for stale detection). |
| `src/cursorScript.ts` | The shared self-contained cursor overlay (used by CDP injection AND `content/virtualCursor.ts`). |
| `src/actGate.ts` | `decideAct` — per-origin consent (observe/navigate free; interact prompts; destructive confirms). `isRestrictedUrl`. |
| `src/actTools.ts` | The LLM tool surface: specs (read_page/pointer/keyboard/scroll/navigate), tool-input→verb mapping, the paired JSON-action contract (`parseActAction`, `buildPairedActPrompt`, `runActByName`), steering prompts. |
| `src/actStore.ts` | Serialized `nb.actRun` mutator (transcript, budget, grants). |
| `src/actRun.ts` | Run lifecycle: start → grant → `drive()` (attaches to the active tab, picks paired `runPairedLoop` or BYOK `runByokLoop`) → stop. |

### Record & automate (subsystem 4)
Schema/distiller/apply live in **`@nff-brain/core`** (`trace.ts`,
`traceCompact.ts`, `workflow.ts`, `workflowDistill.ts`, `workflowApply.ts`).
The extension side:
| Path | What |
|---|---|
| `content/traceRecorder.ts` + `traceDescriptor.ts` | Capture-phase recorder + semantic target descriptors (never CSS paths; redacts passwords). |
| `src/traceCapture.ts` | SW side: validate/stamp-url/gate/ring events (`nb.traceActive`), start/stop, cap→auto-stop. |
| `src/standaloneTraceDistill.ts` | On stop (BYOK), distill the trace into a workflow node in the local brain. |

Server counterparts (in `packages/cli/src/serve/`): `actRoutes.ts`
(`POST /v1/act/step` — the paired agent's `claude -p` brain step), `chatRoutes.ts`,
`agentRoutes.ts`.

---

## Build & test

```bash
npm run build -w nff-brain-chrome     # esbuild → dist/ (the load-unpacked dir & the store zip)
npm run watch -w nff-brain-chrome     # rebuild on change
npm run package -w nff-brain-chrome   # dist/ → nff-brain-chrome.zip
npx vitest run                        # whole monorepo suite (from repo root)
npx tsc -p packages/chrome --noEmit   # typecheck
```

- Bundler: `build.mjs` (esbuild, one IIFE per entry, `target: chrome116`,
  `conditions: ['nff-brain-source']` so `@nff-brain/core` resolves to TS source).
- `NFF_BRAIN_TEST_MANIFEST=1 npm run build` writes an eval-harness manifest
  variant that promotes optional permissions to install-time grants (unpacked
  loads auto-grant them). **Never ship it** — `zip.mjs` refuses a dist with
  `host_permissions`.

### CI tripwires — deliberate edits, not drive-by
`test/manifest.test.ts` pins the exact permission set + `side_panel` key.
`test/bundlePurity.test.ts` pins: content-script purity (no fetch/token/storage;
only `runtime.ts` sends, only `recorderEvent`/`traceEvent`), the four documented
module vars, top-level SW listeners, the `@nff-brain/core` subpath allowlist, the
`shouldCapture`/hostname reader call sites, and the exact `dist/` file list.
Widening any of these means editing the test in the same commit.
