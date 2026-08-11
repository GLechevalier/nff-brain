# nff-brain — Reference Documentation

Local-first knowledge-graph memory for Claude Code. This document is the full
reference: the data model, how each part of the session loop works, every CLI
command, the graphify codebase-map bridge, and the knobs you can turn. For a
quick start, see the [README](../README.md).

---

## 1. Mental model

nff-brain maintains a **knowledge graph in a plain JSON file** and wires it into
Claude Code through two hooks:

```
SessionStart ──► nff-brain recall  ──► relevant subgraph printed into context
                                        (LLM-free, instant, fail-open)

  … you work with Claude Code normally …

SessionEnd ────► nff-brain distill ──► one `claude -p` call turns the transcript
                                        into new/refined nodes (fail-open)
```

Four kinds of knowledge live in the same graph, distinguished by `origin`:

| origin | Created by | Consolidation | Meaning |
|---|---|---|---|
| `seed` | `init`, `add`, VS Code | never auto-evicted or auto-merged | curated knowledge |
| `agent` | `distill` | folded/pruned when the graph grows | learned lessons |
| `import` | `import` (§12) | folded/pruned like `agent` | mined from past sessions |
| `graphify` | `ingest-graphify` | never folded/pruned; **replaced wholesale on re-import** | codebase map |

`import` deliberately shares `agent`'s consolidation rules: machine-proposed
knowledge should not be immortal. Refining a `seed` keeps it a `seed`.

## 2. Files on disk

| Path | What |
|---|---|
| `<workspace>/.nff-brain/brain.json` | project brain (the default target of every command) |
| `~/.nff-brain/brain.json` | global brain (`--global` flag) |
| `<workspace>/.nff-brain/brain.json.lock/` | lock **directory** (mkdir is atomic everywhere); stale after 10 s |
| `<workspace>/.nff-brain/last-recall.log`, `last-distill.log` | fail-open hook logs — first place to look when a hook "did nothing" |
| `<workspace>/.nff-brain/vectors.json` | optional embedding sidecar (§11) — derived data, git-ignored, safe to delete |
| `~/.nff-brain/runtime/`, `~/.nff-brain/models/` | optional embedding runtime + model weights (§11); absent unless `semantic install` ran |
| `.claude/settings.json` | where `install-hooks` merges the two hook entries |

The workspace root is found by walking up from the cwd until a `.nff-brain`,
`.claude`, or `.git` directory appears. Writes are atomic (temp file + fsync +
rename, with a Windows EPERM retry loop). Recall reads a **merged view** of
project + global brains — the project wins on id collision.

## 3. The graph model

```jsonc
{
  "version": 1,
  "updatedAt": "2026-08-10T…",
  "nodes": [{
    "id": "docker-restart-procedure",   // kebab slug, ≤ 60 chars
    "title": "Docker restart procedure",// ≤ 80 chars
    "category": "rules",                // core | analysis | rules | strategy
                                        // | decision | preference | task
    "content": "When containers wedge, force-recreate them because …", // ≤ 1200 chars
    "color": "#4ade80", "x": 400, "y": 300, "size": 16,  // board placement
    "origin": "agent",                  // seed | agent | graphify | import
    "sourceSession": "…",               // distill only: which session taught it
    "lastUpdated": "…", "recallCount": 3, "lastRecalledAt": "…",
    "confidence": 0.82,                 // import only, 0..1 — see §12
    "importedFrom": ["sess-a", "sess-b"], // import only: sessions it came from
    "graphifyRef": {                    // graphify origin only — see §6
      "graph": "graphify-out/graph.json",
      "kind": "community",              // community | node | hyperedge
      "key": 0,
      "children": ["auth_login", "session_store", "…"]
    }
  }],
  "edges": [{ "from": "a", "to": "b", "strength": 0.8 }]  // undirected, 0..1
}
```

Categories map to colors and glyphs everywhere (CLI, VS Code):
`core` #00ffcc ◈ · `analysis` #22d3ee ⊕ · `rules` #4ade80 ▦ · `strategy` #a78bfa ↑ ·
`decision` #fbbf24 ⌘ · `preference` #f472b6 ☺ · `task` #fb923c ☐.

The last three arrived with the history importer (§12) and are first-class
everywhere: `nff-brain add --category decision`, the distiller may emit them,
and they round-trip through the markdown editor. Note the palette is only
*stored* — the VS Code webview renders theme colors and conveys category by the
glyph alone.

`recallCount` is the value signal: recalled nodes get bumped, and consolidation
always evicts/folds the **least-recalled** nodes first.

## 4. The session loop in detail

### Recall (SessionStart, LLM-free)

- Graphs with **≤ 40 nodes** are injected whole — no retrieval at all.
- Bigger graphs run two-step GraphRAG:
  1. **Seed** — lexical scoring (token overlap + trigram similarity) of the task
     text against every node; top 6 above a 0.05 floor.
  2. **Expand** — the strongest edges pull in neighbors until 12 nodes total.
- Node content is trimmed to 600 chars in the preamble.
- Every included node's `recallCount` is bumped.
- Codebase-map nodes are rendered with an `(expand: nff-brain expand <id>)`
  hint plus a one-line footer explaining the drill-down (§6).

### Distill (SessionEnd, one `claude -p` call)

- Transcripts under **200 chars** are skipped (trivial sessions).
- The prompt carries the task text, the transcript (capped at 12 000 chars), and
  the current node list; the model returns strict JSON. **At most 3 new nodes**
  per session; reusing an existing id refines that node in place.
- The LLM call runs **outside** the file lock; only the fast delta-apply runs
  under it.
- After applying, the graph is pruned to **400 nodes** — counting and evicting
  only `agent` nodes (seeds are immortal, graphify nodes don't count, `core`
  category is protected).
- Hard fail-open: any error logs to `.nff-brain/last-distill.log` and exits 0.

### Consolidation (`nff-brain merge`)

- Default: **fold least-used** — ~25 % of the coldest `agent` nodes fold into
  their nearest surviving neighbor (strongest edge → most similar text → the
  hub). Content is appended, edges repointed — knowledge is kept, not deleted.
  A floor of 8 nodes is always kept.
- `--llm`: additionally a trigram shortlist of near-duplicate pairs is judged by
  the LLM; confirmed pairs are merged with LLM-authored combined text.
- `seed` and `graphify` nodes are never victims; `graphify` nodes also never
  *absorb* folded content (it would vanish on the next re-import).

## 5. CLI reference

Every command targets the project brain; add `--global` for `~/.nff-brain`.
`--key value` and `--key=value` are both accepted.

### Setup

| Command | Notes |
|---|---|
| `init [--hooks] [--global] [--import]` | creates the brain with a hub node; if `CLAUDE.md`/`AGENTS.md` exists, splits it into `seed` nodes via one `claude -p` call. `--hooks` also runs install-hooks; `--import` also runs the history scan (§12), leaving a preview to review — it never commits unreviewed. Without `--import`, init just reports how many past sessions are available. |
| `import [--limit 40] [--since 7d] [--all] [--project P] [--min-confidence 0.5] [--concurrency 4] [--force] [--yes]` | mine past Claude Code sessions → `.nff-brain/import-preview.md`. Writes **nothing** to the brain. See §12. |
| `import --apply [--max-new 60] [--force]` | commit the items still checked in that preview. |
| `install-hooks [--global] [--apply-model]` | merges the two hook entries into `.claude/settings.json` (never clobbers; one-time backup at `settings.json.bak-nff-brain`). The SessionEnd entry carries `timeout: 120` — required, Claude Code otherwise cancels the distill before the LLM answers. `--apply-model` installs the prompt hook as `novelty --stdin-hook --apply-model` so it also writes the chosen tier into `settings.local.json` (§7). |
| `model [--write] [--query q] [--from-score] [--json]` | which tier the **next** session should launch on. Defaults to the tier the live sessions settled at; `--from-score` forces a fresh context score. `--write` applies it to `.claude/settings.local.json`, preserving every other key. |
| `uninstall-hooks [--global]` | removes exactly the entries whose command contains `nff-brain`. |
| `doctor` | checks the claude CLI, brain files, stale locks, hooks, model in effect. Exit code reflects health. |
| `upgrade` / `--version` | `npm install -g nff-brain@latest` / print version. |

### Session loop (normally run by the hooks)

| Command | Notes |
|---|---|
| `recall [--query q] [--stdin-hook]` | print the preamble (exactly what Claude sees). `--stdin-hook` reads the Claude Code hook payload from stdin. |
| `distill [--transcript p] [--session id] [--model m] [--stdin-hook]` | distill a transcript into nodes. |

### Graph editing

| Command | Notes |
|---|---|
| `list` | all nodes, merged project + global view |
| `search <query> [--limit 10] [--semantic\|--lexical] [--explain]` | rank nodes by relevance; hybrid lexical + embedding when semantic search is enabled (§11) |
| `show <id>` | one node's memory document |
| `add --title T --content C [--category c] [--id i]` | add a curated (`seed`) node |
| `edit <id> [--title T] [--content C] [--category c]` | edit any node |
| `rm <id>` | delete a node and its edges |
| `link <a> <b> [--strength 0.6]` / `unlink <a> <b>` | connect / disconnect |
| `reinforce <a> <b> [--delta 0.1]` | strengthen a connection |
| `merge [--ratio 0.25] [--llm] [--model m]` | consolidate (§4) |

### Semantic search (optional — see §11)

| Command | Notes |
|---|---|
| `semantic [status\|install\|uninstall]` | manage the local embedding runtime in `~/.nff-brain/runtime`. `install` npm-installs it and prefetches the weights; `status` is the only command that loads the model. |
| `index [--global] [--all] [--force] [--check] [--json]` | embed nodes into `.nff-brain/vectors.json`, re-embedding only what changed. **Exits 0 when the runtime is absent** so scripts never break; `--check` reports staleness without loading the model. |

### Codebase map (graphify bridge)

| Command | Notes |
|---|---|
| `ingest-graphify [--dir graphify-out] [--max-per-repo 10] [--no-llm] [--model m] [--global]` | import a graphify graph — see §6 |
| `expand <id>` | list a codebase-map node's underlying code entities live from graph.json |

## 6. The graphify codebase-map bridge

[graphify](https://github.com/safishamsi/graphify) (`/graphify` in Claude Code)
turns a folder of code/docs into an entity-level knowledge graph
(`graphify-out/graph.json` — often thousands of nodes). The brain deliberately
stays tiny, so `ingest-graphify` imports only a **compressed layer** whose goal
is to bridge *user intent* to *code meaning and organization*: each imported
node explains what a part of the system is for and points at the exact
entities/files that implement it.

### What gets imported — at most `--max-per-repo` (default 10) nodes per repo

Candidates are attributed to a repo by the top-level path segment of their
members' source files (majority vote), then selected round-robin
area → flow → god with per-kind slot caps, leftover slots backfilled with more
areas:

| Kind | Source | Slot cap | id prefix | category |
|---|---|---|---|---|
| **area** | a graphify community (label from `GRAPH_REPORT.md`; `"Module Group N"` placeholders fall back to a title derived from the community's top hubs) | 5 | `gf-area-` | `analysis` |
| **flow** | a named hyperedge (e.g. *"PKCE OAuth Server Flow"*), ranked by confidence then size | 3 | `gf-flow-` | `strategy` |
| **god** | a hub entity by total degree (≥ 3 connections) | 2 | `gf-god-` | `core` |

Dropped candidates are logged per repo (`nff: kept 10 of 343 candidates`).

### Node content = intent + pointers

Each node's content is:

1. **Intent** — 1–3 sentences written by **one batched `claude -p` call** (all
   nodes in a single prompt): what this part of the system is *for*, why it
   exists, what an agent should know before touching it. Strictly fail-open —
   if claude is missing, times out, or returns junk (or with `--no-llm`), the
   import still succeeds with mechanical summaries.
2. **Mechanical pointers** — key member entities with their source files, and a
   `↳ graphify <community N | node id | hyperedge id> — nff-brain expand <id>`
   line.

Every node also carries a machine-readable **`graphifyRef`** (graph path
relative to the workspace root, kind, key, child graphify-node ids) — the
first-class bridge that `expand` and future tools resolve.

### Guarantees

- **Wholesale replace:** re-running `ingest-graphify` deletes every
  `origin: 'graphify'` node and writes the fresh set. Idempotent; keeps the map
  in sync after `/graphify --update`. Seeds/lessons and their edges are never
  touched.
- **Never folded:** graphify nodes are excluded from every consolidation path —
  as victims *and* as survivors — because anything merged into one would be
  silently lost on the next re-import.
- **No budget pressure:** they don't count toward the 400-node distill cap.
- Edges are imported too: god ↔ its area (0.9), flow ↔ its majority area
  (confidence), and the strongest cross-community area ↔ area links (top 2 per
  area).

### The drill-down

```
$ nff-brain expand gf-flow-pkce-oauth-server-flow
PKCE OAuth Server Flow — hyperedge pkce_oauth_server_flow (9 entities)
  GET /authorize handler — nff-rs/nff/src/oauth.rs (code)
  pkce_challenge() S256 — nff-rs/nff/src/oauth.rs (code)
  …
relations:
  GET /authorize handler -calls-> bind_callback_server()
  POST /token handler PKCE S256 -calls-> pkce_challenge() S256
```

`expand` resolves the node's `graphifyRef` against the *current* graph.json, so
it reflects the latest graphify run; stale child ids are reported. Recall
advertises the command on every codebase-map node it surfaces, so agents
discover the bridge without being told.

### Typical loop & gotchas

```sh
/graphify --update            # (in Claude Code) refresh the entity graph
nff-brain ingest-graphify     # re-import the compressed map
```

- Re-running with `--no-llm` **overwrites** previously LLM-written intent with
  mechanical summaries — run without the flag to restore it.
- If `expand` says the graph is missing, the graph.json moved or was cleaned —
  re-run `/graphify`, then `ingest-graphify`.

## 7. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `NFF_BRAIN_MODEL` | `haiku` | model for every `claude -p` call (`init`, `distill`, `merge --llm`, `ingest-graphify`); per-call `--model` wins |
| `NFF_BRAIN_TIMEOUT_MS` | `60000` | hard timeout for each `claude -p` call (process tree is killed on expiry) |
| `NFF_BRAIN_CLAUDE_BIN` | `claude` | claude binary override (tests use a shim) |
| `NFF_BRAIN_CLAUDE_HOME` | `CLAUDE_CONFIG_DIR`, else `~/.claude` | where `import` looks for Claude Code's session history (§12) |
| `NFF_BRAIN_SKIP` | — | set to `1` in the env of nff-brain's own `claude -p` children; both hooks exit immediately when they see it. **Recursion guard — never remove.** |

Auto-model (novelty scoring → `.nff-brain/model-request.json`). These pick the
**session** model and are unrelated to `NFF_BRAIN_MODEL` above, which is the
distiller's own model.

| Variable | Default | Effect |
|---|---|---|
| `NFF_BRAIN_MODEL_LADDER` | `sonnet,opus,fable` | tiers from cheapest to frontier; the extension types the names verbatim as `/model <name>` |
| `NFF_BRAIN_NOVELTY_THRESHOLDS` | `0.35,0.7` | **static** cut points between tiers; needs exactly `ladder length − 1` ascending values in (0,1). Setting this disables calibration — an explicit choice outranks the calibrator |
| `NFF_BRAIN_NOVELTY_QUANTILES` | `0.5,0.85` | where the **calibrated** cuts sit in the observed distribution: bottom 50 % of prompts run cheap, top 15 % get the frontier |
| `NFF_BRAIN_NOVELTY_CALIBRATE` | `1` | set to `0` to keep the static cuts and ignore the sample history |
| `NFF_BRAIN_MIN_SIGNAL_TOKENS` | `2` | meaningful query tokens below which a prompt carries no opinion and the current tier is held (`ok`, `yes`, `continue`) |
| `NFF_BRAIN_NOVELTY_HYSTERESIS` | `0.05` | dead band around each cut, so novelty wobbling at a boundary cannot flap tiers |
| `NFF_BRAIN_DOWNGRADE_STREAK` | `2` | consecutive below-band prompts required before giving up an expensive tier; upgrades are immediate |

All of these fall back to their defaults on a malformed value — a typo can never
break a hook.

**Calibration.** Novelty is not an absolute quantity: it depends on how big and
how well-connected the graph is, so fixed cuts mean different things on a
10-node brain and a 400-node one. Measured on a real 42-node brain, the static
`0.35/0.7` cuts made the cheapest tier **unreachable** — 30 varied prompts split
0 / 11 / 19 across the ladder. The hook therefore records each scored prompt's
novelty in `.nff-brain/novelty-samples.json` (a 200-entry ring buffer) and once
25 prompts have been seen it places the cuts at quantiles of that distribution
instead. The same 30 prompts then split 15 / 10 / 5. Cuts that cannot form a
usable ladder — too few samples, or a distribution so flat the quantiles are not
strictly ascending — silently fall back to the static values.

**Applying the choice.** `install-hooks --apply-model` lets the prompt hook
write the chosen tier into `.claude/settings.local.json`'s `model` field, which
is the only mechanism that actually changes which model Claude Code runs. Every
other lever was measured and ruled out against Claude Code 2.1.228: no hook
output can set the model, `terminalSequence` is allowlisted to notification
escapes, and the VS Code extension exposes no model command.

⚠ **The model binds at session creation and is never re-read** — not even on
`--resume`. Nothing can retier a session that is already running; each session
starts on the tier the brain settled at during the previous one. The older
`--auto-model` path (extension types `/model` into a terminal) additionally
requires `claudeCode.useTerminal`, which is **not** the default — in the native
panel there is no terminal to type into.

Semantic search (optional — see §11). None of these affect the hooks.

| Variable | Default | Effect |
|---|---|---|
| `NFF_BRAIN_SEMANTIC` | `auto` | `auto` = hybrid when the runtime and a vector index both exist; `on` = also explain when it can't; `off` = never |
| `NFF_BRAIN_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | embedding model. **Not** `NFF_BRAIN_MODEL` — that is the distiller's `claude -p` model. Changing this invalidates the whole index and needs the floor re-tuned |
| `NFF_BRAIN_RUNTIME_DIR` | `~/.nff-brain/runtime` | where `semantic install` puts the embedding runtime |
| `NFF_BRAIN_EMBED_CACHE_DIR` | `~/.nff-brain/models` | model weight cache (mirrors the worker's `BRAIN_EMBED_CACHE_DIR`) |
| `NFF_BRAIN_TRANSFORMERS` | — | explicit path to the package dir or entry file; bypasses resolution |
| `NFF_BRAIN_EMBED_OFFLINE` | — | `1` forbids any network fetch; a cache miss then fails fast to lexical instead of downloading |
| `NFF_BRAIN_SEMANTIC_FLOOR` | `0.55` | minimum cosine for a semantic candidate — **model-specific**, see §11 for how it was measured |
| `NFF_BRAIN_HYBRID_K` | `60` | RRF constant; larger = flatter, less top-heavy |
| `NFF_BRAIN_HYBRID_WEIGHTS` | `1,1` | `lexical,semantic` weights in the fusion |

## 8. VS Code extension

- **Open**: `nff-brain: Open Brain` from the command palette, the status-bar
  `brain` item, or the activity-bar side view.
- The graph is pure inline SVG (no chart libraries), themed via VS Code color
  variables; a search bar filters nodes live.
- Clicking a node opens it as a **native markdown editor tab** (an
  `nffbrain:` virtual document). Saving writes title/category/body/links back
  to `brain.json` under the store lock. The meta line shows
  `curated` / `learned` / `codebase map` by origin.
- The ⤵ Merge button runs the same fold pass as `nff-brain merge`.

## 9. Development

```sh
npm ci
npm run build     # CLI (tsup) + VS Code extension (esbuild)
npx vitest run    # unit + e2e (e2e runs the BUILT CLI against a mocked claude)
```

Layout: `packages/core` (types, store, recall, distill, mergePass,
ingestGraphify, hooksConfig — all shared logic, dependency-light),
`packages/cli` (the `nff-brain` bin; hand-rolled flag parser in `util.ts` —
**new value-taking flags must be added to `VALUE_FLAGS`**), `packages/vscode`
(extension + webview; `F5` launches the Extension Development Host).

The e2e suite fakes claude with `packages/cli/test/fixtures/claude-shim.mjs`,
which branches on marker phrases in the prompt (`memory architect` = init,
`memory distiller` = distill, `graph explainer` = ingest-graphify);
`SHIM_MODE=hang` never answers, which is how fail-open is proven.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Nothing recalled at session start | `nff-brain recall --query "…"` manually; `.nff-brain/last-recall.log`; `nff-brain doctor` |
| Brain never learns | `.nff-brain/last-distill.log`. Most common cause historically: the SessionEnd hook missing its `timeout: 120` — `install-hooks` repairs old installs in place. |
| `timed out after 60000ms` in logs | slow model/login — raise `NFF_BRAIN_TIMEOUT_MS` |
| `timed out waiting for lock` | a crashed process left `brain.json.lock/`; it is stolen automatically after 10 s, or delete the directory |
| Hook seems to run twice / recursively | `NFF_BRAIN_SKIP` guard missing from env — see §7 |
| `expand` says graph not found | re-run `/graphify`, then `nff-brain ingest-graphify` |
| Search misses obvious paraphrases | semantic search is probably off — `nff-brain doctor`, then §11 |
| `doctor` says "installed but unusable" | the native onnxruntime binary would not load (musl/Alpine, ARM32, old glibc). `nff-brain semantic status` prints the real error. Search still works, lexically. |
| Semantic results look stale after editing a node | the sidecar is keyed by content hash — run `nff-brain index` |

## 11. Semantic search (optional)

Lexical ranking (§3) is excellent at ids, slugs and acronyms and blind to
paraphrase: *"how much money is this actually saving me"* shares no tokens and
no trigrams with *"Model token savings as avoided rediscovery cost"*. Semantic
search closes that gap by embedding every node and fusing cosine similarity
with the lexical score.

```
nff-brain semantic install     # one-time, ~400 MB runtime + ~33 MB weights
nff-brain index                # embed nodes → .nff-brain/vectors.json
nff-brain search "how much money is this actually saving me"
```

```
lex   sem   id                                   node
 ·    0.59  token-savings-counterfactual-model  [core] Model token savings as avoided rediscovery cost
```

`·` means that signal did not rank the node at all — above, the hit is purely
semantic. Use `--lexical` to force the old behaviour, `--semantic` to be told
why it is unavailable, and `--explain` for a legend.

**It is genuinely optional.** The published CLI has zero runtime dependencies
and the VSIX ships `--no-dependencies`; the embedding runtime is npm-installed
on demand into `~/.nff-brain/runtime` and resolved at runtime. Absent, broken,
or the wrong CPU architecture, every code path falls back to lexical ranking —
`index` still exits 0, and `doctor` reports semantic with a `·`, never a `✗`.

### What it does not touch

The hooks stay lexical and stay fast: `recall` (SessionStart) and `novelty`
(UserPromptSubmit) gain no import, no file read and no model load. That is
deliberate — `novelty` derives coverage as `topScore / 0.35` against the frozen
lexical scale (§3), and feeding it cosines would saturate coverage at 1.0 for
every query and pin the model ladder forever. `score.ts` carries a freeze
contract comment; `score.test.ts` pins exact values as a tripwire.

### How the ranking works

Fusion is **Reciprocal Rank Fusion**, not a weighted sum, because the two
scores are not commensurable — a mid-range cosine would otherwise outrank a
genuine lexical hit. Each list contributes `weight / (60 + rank)`.

A semantic candidate must clear both an absolute floor (`0.55`) and a relative
one (within `0.10` of the best cosine seen). Those numbers are **specific to the
model and its query prefix**, and were measured, not copied — over the 14-node
dev brain with `Xenova/bge-small-en-v1.5`:

| | cosine |
|---|---|
| true positives (6 paraphrase queries, no token overlap) | 0.59 – 0.73 |
| plausible runners-up | 0.52 – 0.55 |
| unrelated query (*"how do I bake sourdough bread"*) | 0.38 – 0.42 |

To re-tune after changing `NFF_BRAIN_EMBED_MODEL`, repeat the measurement and
put the floor between the worst true positive and the best noise hit:

```
NFF_BRAIN_SEMANTIC_FLOOR=0 nff-brain search "<paraphrase>" --limit 8
```

### Storage

Vectors live in `.nff-brain/vectors.json` beside each brain, **never inside
`brain.json`** — that file is pretty-printed, hand-editable, round-trips through
the `nffbrain:` markdown editor, and is parsed on every hook invocation. The
sidecar holds base64 little-endian float32 (~840 KB at the 400-node cap), is
git-ignored automatically, and is pure derived data: deleting it costs one
`nff-brain index`, never a node. `brain.json` stays schema version 1, so older
CLIs keep working.

Each entry is keyed by `sha256(model + title + content)`, so `index` re-embeds
only what actually changed and a model switch invalidates everything.

## 12. Importing Claude Code history

A fresh brain only grows as new sessions end, so the first days feel empty —
while the history that would fix that is already on disk. `nff-brain import`
mines `~/.claude/projects/**/*.jsonl` into memories.

```sh
nff-brain import          # scan → .nff-brain/import-preview.md   (brain untouched)
nff-brain import --apply  # commit whatever is still checked
```

### Two phases, split by a file you read

Phase one writes **nothing** to `brain.json`. It produces two files:

| File | Owner | Holds |
|---|---|---|
| `.nff-brain/import-preview.md` | you | checkbox state and any text you rewrote |
| `.nff-brain/import-pending.json` | the tool | ids, refine targets, provenance, ledger hashes |

The split matters: identity never comes from prose. Fixing a typo in a title
must not re-slug the node id, because that id was already collision-checked
against the graph and re-deriving it could silently clobber a different node.

In the markdown you may untick a box, rewrite a title or body, or delete a whole
block to reject it. A deleted block counts as rejected, never as still-pending.

### What it extracts

Five kinds, mapped onto the seven categories:

| Kind | Category | What counts |
|---|---|---|
| memories | `strategy` | durable procedures and gotchas |
| decisions | `decision` | a choice that was MADE and stuck, with its reason |
| preferences | `preference` | how this developer wants to work — stated or repeatedly enforced |
| tasks | `task` | work explicitly deferred and still open |
| failures | `analysis` | an approach that was tried and did NOT work, and why |

`failure` folds into `analysis` on purpose: "we tried X, it failed because Y"
*is* an analysis finding, and a separate category would give the palette two
overlapping buckets with no distinct recall behaviour.

### Confidence

The model self-reports 0..1 (0.9 stated as a rule · 0.7 demonstrated and
confirmed · 0.4 inferred). That is then tempered by things it cannot see — a
short session, a user push-back mid-session, a months-old TODO — and finally
**boosted by repetition**: each extra session proposing the same lesson closes
30% of the remaining gap to 1, so 0.5 seen in five sessions reads 0.88.

That boost is the whole reason to import in bulk rather than one session at a
time: the per-session distiller can never see that a lesson recurred.

Confidence decides only which items start **checked** (`--min-confidence`,
default 0.5). Low-confidence items are still listed, just unticked.

### Dedup, in three places

1. **Across the proposals** — trigram clustering (0.55, same gate as
   `merge --llm`) folds restatements into one item and unions their sources.
   Kinds never cross.
2. **Against the brain** — an exact id hit refines; ≥ 0.72 similarity is a
   `duplicate` (listed under "Already known", unchecked whatever its
   confidence); in between is a refine. graphify nodes are excluded — they are
   replaced wholesale on re-ingest, so refining one would lose the edit.
3. **Against history** — `.nff-brain/import-state.json` remembers every mined
   session and a `kind:slug(title)` hash of every accepted proposal. A session
   is re-read only if it GREW (i.e. was resumed). The hash guard survives you
   *deleting* the node, which is precisely when re-offering it would be most
   irritating. `--force` bypasses both, which is how you recover a deleted
   memory.

### What it refuses to read

- **Its own `claude -p` calls.** Every LLM call nff-brain makes lands in
  `~/.claude/projects` as its own transcript. They are detected by their opening
  line (`NFF_PROMPT_MARKERS` in core, shared with the prompt builders so they
  cannot drift) and skipped — otherwise the brain learns about being a memory
  distiller. In this repo's own folder they are *all* there is.
- **Sidechains.** `<sessionId>/subagents/*.jsonl` are fragments of a parent
  session and would double-count it.
- **Live sessions.** Anything in `~/.claude/sessions/*.json` that has not exited,
  plus `CLAUDE_CODE_SESSION_ID` — an in-progress transcript has no conclusions
  yet. It is picked up on a later run.
- **One-shots and stubs** — single-turn, untitled, under 4 KB.

### Notes on the on-disk format

Two things bite anyone parsing this tree:

- **The directory encoder is not stable across Claude Code versions.** Both
  `…-R-D-MCPIOT-…` and `…-R_D-MCPIOT-…` exist for the same path. Encoding is
  only a fast path here; the truth is the `cwd` field inside the file — which is
  *not* on the first record (that is usually `queue-operation`).
- **`ai-title` is rewritten as a session evolves**, ~19 times in a long one. The
  last one is the good one, which is why the probe reads a tail window too.

Transcripts run to several MB, so metadata comes from bounded 128 KB head +
64 KB tail reads: 1500 files scan in ~150 ms instead of ~700 ms and 220 MB.

### Cost and privacy

One `claude -p` call per session, 4 at a time, each carrying ~12 KB of
transcript — so 40 sessions is roughly four minutes and ~500 K input tokens.
The count and estimate are printed *before* anything is spent.

Transcripts contain secrets, absolute paths, pasted logs and other clients'
code. This is the same trust boundary as the SessionEnd distill hook, but
`--all` and `--project` widen it across projects, so both are explicit and
`--all` prints a per-project breakdown and requires `--yes`.
