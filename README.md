# nff-brain

**CLAUDE.md sucks, so replace it with a local-first knowledge-graph that picks the right language model to save tokens.**

`nff-brain` replaces flat `CLAUDE.md` memory with a knowledge graph that lives on
your machine as a plain JSON file. Claude Code **recalls** the relevant part of
the graph at the start of every session, and **distills** what it learned into
new nodes when the session ends — automatically, through Claude Code hooks.
A VS Code extension renders the brain as an interactive graph (square nodes on a
pannable canvas, memory document beside it) where you can edit, delete, link and
reinforce knowledge.

- **Local only.** The brain is a JSON file (`.nff-brain/brain.json`). Nothing is
  hosted, nothing leaves your machine. The VS Code UI is bundled and offline.
- **No API key.** Distillation runs through your existing `claude` CLI login
  (one small `claude -p` call per session end). Recall is pure-local and instant.
- **Yours to edit.** Every node and link is visible and editable — in VS Code or
  from the CLI.

## Install

**npm**

```sh
npm install -g nff-brain
```

**curl (macOS/Linux)**

```sh
curl -fsSL https://raw.githubusercontent.com/GLechevalier/nff-brain/main/install.sh | sh
```

**PowerShell (Windows)**

```powershell
irm https://raw.githubusercontent.com/GLechevalier/nff-brain/main/install.ps1 | iex
```

**VS Code extension** — install “nff-brain” from the Marketplace (or grab the
`.vsix` from a GitHub release and `code --install-extension nff-brain-*.vsix`).

### Upgrade

```sh
nff-brain upgrade          # wraps: npm install -g nff-brain@latest
```

or just re-run any install command above — `npm install -g` is
install-or-upgrade. Check what you have with `nff-brain --version`.

## Quick start

```sh
cd your-project
nff-brain init --hooks
```

`init` creates `.nff-brain/brain.json` with a project hub node and — if a
`CLAUDE.md` / `AGENTS.md` exists — splits it into graph nodes with one
`claude -p` call. `--hooks` wires two hooks into `.claude/settings.json`:

| Hook | Command | What it does |
|---|---|---|
| `SessionStart` | `nff-brain recall --stdin-hook` | Prints the relevant subgraph into Claude's context. LLM-free, instant, fail-open. |
| `SessionEnd` | `nff-brain distill --stdin-hook` | One `claude -p` call turns the session transcript into new/refined nodes. Fail-open. |

Then just use Claude Code normally. The brain grows as you work; open the graph
in VS Code as a full editor tab (`nff-brain: Open Brain` from the command
palette, or the status-bar `brain` item) to watch it live, edit nodes, delete
them, or reinforce links.

## How recall works

Small graphs (≤ 40 nodes) are injected whole. Bigger graphs go through two-step
GraphRAG: lexical scoring (token overlap + trigram similarity) seeds the most
relevant nodes, then the strongest edges pull in their neighbors, up to 12 nodes.
Recalled nodes get a `recallCount` bump — the value signal that protects them
from eviction when the graph is later consolidated.

## CLI

```
nff-brain init [--hooks] [--global]     create + seed the brain
nff-brain doctor                        check claude CLI, brain files, hooks
nff-brain list | show <id>              inspect the graph
nff-brain search <query> [--limit 10]   rank nodes by relevance to a query
nff-brain add --title T --content C     add a curated node
nff-brain edit <id> [--title|--content|--category]
nff-brain rm <id>                       delete a node and its links
nff-brain link <a> <b> [--strength]     connect two nodes
nff-brain reinforce <a> <b> [--delta]   strengthen a link
nff-brain unlink <a> <b>                remove a link
nff-brain merge [--ratio 0.25] [--llm]  consolidate: fold least-used nodes; --llm dedups
nff-brain recall [--query q]            print the preamble (what Claude sees)
nff-brain distill --transcript <jsonl>  distill a transcript manually
nff-brain uninstall-hooks               remove exactly the nff-brain hook entries
nff-brain upgrade                       npm install -g nff-brain@latest
nff-brain --version                     print the CLI version
```

Everything targets `<workspace>/.nff-brain/brain.json`; add `--global` for the
user-level brain at `~/.nff-brain/brain.json`. Recall merges both (project wins).

### Model (cost control)

Distillation defaults to **haiku** — the cheapest model that handles the job.
Override per call with `--model` (`init`, `distill`, `merge --llm`) or globally
with the `NFF_BRAIN_MODEL` env var. Recall never calls an LLM. `nff-brain
doctor` shows the model currently in effect.

## The graph model

```jsonc
{
  "version": 1,
  "nodes": [{
    "id": "docker-restart-procedure",       // kebab slug
    "title": "Docker restart procedure",
    "category": "rules",                    // core | analysis | rules | strategy
    "content": "When containers wedge, force-recreate them because …",
    "x": 400, "y": 300, "size": 16,         // board position (the UI relaxes overlaps)
    "origin": "seed",                       // seed = curated, agent = distilled
    "recallCount": 3, "lastUpdated": "…"
  }],
  "edges": [{ "from": "a", "to": "b", "strength": 0.8 }]   // 0..1
}
```

Curated (`seed`) nodes are never auto-evicted or auto-merged away. Learned
(`agent`) nodes are capped (400) and consolidated by folding the least-recalled
ones into their nearest neighbour — knowledge is appended, not deleted.

## Development

```sh
npm ci
npm run build       # CLI (tsup) + VS Code extension (esbuild)
npx vitest run      # 46 unit + e2e tests (e2e uses a mocked claude binary)
```

Repo layout: `packages/core` (graph store, recall, distill, merge, hooks —
shared logic), `packages/cli` (the `nff-brain` bin), `packages/vscode` (the
extension; `F5` in VS Code launches the Extension Development Host).

The graph UI is ported from the nff platform's dashboard Brain tab — pure inline
SVG, no chart libraries, themed with VS Code color variables.

## License

MIT
