# Act benchmark — browser-action primitives

The first-rung benchmark for the **CDP act agent** (side panel → `actRun.ts` →
`actEngine.ts`, verb vocabulary in `packages/core/src/browserVerbs.ts`): can it
perform low-level browser primitives — hover, right/middle/double click, drag,
nested scrolling, caret editing, form controls, navigation, tabs, downloads,
dialogs, touch? It complements the corporate-task suite (`src/scenarios/`,
real accounts): that one measures *tasks*, this one measures *motor control*.

## Two layers

| Layer | Ids | What runs | Gate |
|---|---|---|---|
| A — engine conformance | `primitives.*.L1` | scripted verb sequences, **no LLM**, deterministic | `RUN_BROWSER=1` or `RUN_EVALS=1` |
| B — agent capability | `primitives.*.L2` | a real `claude -p` run given a natural-language goal | `RUN_EVALS=1` only |

A failure localizes immediately: layer A red = the engine can't do it; layer A
green + layer B red = the model didn't choose/aim the right verbs.

Layer B is real-LLM-only by design — the claude-shim has no branch for the act
steering prompt, and layer A already provides the deterministic tier.

## Architecture (why there is no Playwright here)

A harness-side CDP client (Playwright included) auto-attaches DevTools sessions
to page targets, which **evicts `chrome.debugger`** — the very engine under
test (empirically confirmed; see `harness/chrome.ts`). So the harness holds
zero CDP connections:

- **Bench driver** (`packages/chrome/src/benchDriver.ts`): present only in
  `NFF_BRAIN_BENCH=1` builds. Long-polls the fixture server over loopback for
  commands (`verb` → `executeVerb`, `actStart` → `startActionRun`, `pair` →
  `pairWithServer`, tab/zoom/grant plumbing) and posts results. It can never
  ship: `zip.mjs` refuses a dist containing the `__NFF_BENCH_DRIVER__`
  sentinel, and `test/benchBuild.test.ts` proves the production entry can't
  pull it in.
- **Fixture server** (`src/harness/fixtures.ts`, `127.0.0.1:8917`): serves the
  instrumented pages, carries the driver command channel, and holds the
  **ledger** — pages report every DOM event + a `state()` summary via
  `fixtures/bench.js`, and scenario `verify()` asserts on that ledger. The
  harness never evaluates JS on a page.
- **Chrome** is spawned as a bare child process (`src/harness/chrome.ts`) with
  the bench dist loaded unpacked, profile `.profiles/act-bench` (persists
  grants + pairing).
- Layer B boots its own serve on **port 7375** with state under
  `state/act-brain-home`, so the developer's real `nff-brain serve` on 7373
  keeps running untouched. Pairing happens through the driver (`pair` command)
  and persists in the bench profile.

## Outcomes

Beyond the shared scorecard outcomes, this suite adds:

- 🚫 `out-of-scope` — structurally impossible for a Chrome-extension agent
  (CAPTCHA, OS dialogs, incognito, devtools, browser-UI shortcuts, print).
  Registered so the boundary is documented; never executed.
- 🕳 `known-gap` — the case RUNS and documents a real engine gap; a failing
  verdict is expected. If a known-gap case ever **passes**, the run fails with
  "stale marker" — remove the `knownGap` field in the same change that fixed
  the engine.

Native JS dialog cases (`primitives.dialogs-alert/confirm/prompt/beforeunload`)
are blocked on `ACT-dialogs` and **must not be run** until `dialog.handle` is
implemented: an unanswered native dialog blocks the renderer main thread and
wedges the whole run.

## Capability tags (capabilities.json)

`ACT-harness`, `ACT-engine` (live) · `ACT-engine2` (input-fidelity fixes:
`buttons` bitmask on drag moves, event-count dblclick, tab.open wait-for-commit
+ the `active:false` validator drop) · `ACT-forms` (form.setValue + native
`<select>`) · `ACT-upload` · `ACT-dialogs` · `ACT-clipboard` ·
`ACT-downloads` · `ACT-touch` · `ACT-observe-extras` (page.find/screenshot,
nav.waitFor). Flip a tag live in the same commit that lands the capability;
`test/actRegistry.test.ts` then requires the gated cases to carry `run()`.

## Findings from the first sweep (2026-08-14)

Layer A: **50 pass · 5 known-gap · 0 fail**. Layer B (reps 1, first pass):
**11 pass · 7 fail · 3 blocked**.

Layer B failures cluster on **perception, not motor control**: the agent
nailed clicks, typing, forms, consent-overlay recovery, tabs, history, and
downloads, but failed hover-menu, double-click, drag-reorder, slider-drag,
nested-scroll, caret-edit, and the multi-step wizard (budget exhausted). The
engine passes all of those in layer A — the model simply cannot SEE the
targets: plain `div`/`li`/`span` widgets (slider knob, list items, hover
zones) never appear in the interactive snapshot, so the agent has no
coordinates to aim at. The highest-leverage capability work this suggests:
snapshot coverage for pointer-interactive non-ARIA elements (or a screenshot
channel), before any new verbs. Rep transcripts land next to each scorecard
as `<id>-repN-transcript.json` for diagnosis.

Layer A notable truths:

- **Works, sometimes surprisingly**: HTML5 drag-and-drop (Chrome promotes the
  trusted CDP mouse sequence into a real drag session — the predicted gap did
  not exist), native scrollbar-thumb drag, shift+wheel horizontal remap,
  ctrl+click-opens-tab, middle-click auxclick, Shift+Tab / Shift+End / Ctrl+A
  via the modifier bitmask, per-key typing into date inputs, BFCache
  back/forward, occlusion refusal, nested-container wheel scroll.
- **Known gaps** (all marked): count-based dblclick (one event pair with
  `clickCount:2`), text-selection drag (`mouse()` sends no `buttons` bitmask
  on moves), ctrl+wheel browser zoom (browser-chrome gesture; `page.zoom`
  covers the intent), `tab.open` races its about:blank (switchTo refuses), and
  `validateBrowserVerb` silently drops `active:false`.

## Running it

```powershell
# build the bench extension (never ship this dist)
$env:NFF_BRAIN_BENCH='1'; $env:NFF_BRAIN_TEST_MANIFEST='1'; npm run build -w nff-brain-chrome
npm run build -w "@nff-brain/core"    # evals resolves core through dist at runtime

cd packages/evals
npx tsx src/actRunner.ts --list                          # taxonomy + status
$env:RUN_BROWSER='1'; npx tsx src/actRunner.ts --layer engine [--family pointer] [--id …]
$env:RUN_EVALS='1';  npx tsx src/actRunner.ts --layer agent [--reps 1]
```

(The root `npm run evals:act -- …` scripts exist, but Windows npm mangles `--`
flags — invoking tsx directly is the reliable form.)

Scorecards land under `artifacts/<stamp>/scorecard.{json,md}`. Exit code 1
only on `fail`/`error` — blocked, out-of-scope, and known-gap are healthy.

Env knobs: `NFF_EVALS_CHROME` (chrome.exe path), `NFF_EVALS_FIXTURE_PORT`
(default 8917 — baked into the extension bundle, rebuild after changing),
`NFF_EVALS_SERVE_PORT` (default 7375).
