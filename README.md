
<p align="center">
  <img src="public/images/tumbnail.png" alt="nff" width="640">
</p>

# nff-brain, browser agent that runs in your tab, with your logins

**Your coding agent lives in your terminal. This one lives in your browser.**

`nff-brain` is a Chrome extension that allows an agent to live within your browser or VS Code (though use VS Code is mainly for dev testing, use it on Chrome).

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="https://github.com/GLechevalier/nff-brain/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/GLechevalier/nff-brain/ci.yml?branch=main&label=CI"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white">
</p>

What it does : it places a brain context in your browser grown automatically when you use it, and allows you to automate web tasks :

- **Local only.** The extension runs locally as a chrome process connected with a claude code or your API keys
- **Web navigation** 
- **Automate web workflows** 
- **Connects with other MCP tools**



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

### Start full, not empty

A fresh brain only fills up as new sessions end — so the first days feel empty
while the history that would fix that is already sitting on your disk.
`nff-brain import` mines it:

```sh
nff-brain import          # scan past sessions → .nff-brain/import-preview.md
# review the file: uncheck anything you don't want, edit freely
nff-brain import --apply  # commit what is still checked
```

It reads the Claude Code transcripts in `~/.claude/projects` whose `cwd` matches
this workspace (newest 40 by default), and extracts five kinds of knowledge:
durable memories, architectural decisions, developer preferences, unresolved
tasks, and previous failures. The same lesson found in several sessions is
merged into one memory and gains confidence for each session it appeared in.

**Nothing is written to the brain until you run `--apply`.** The preview is a
normal markdown checklist — untick a box, rewrite a title, or delete a block to
reject it outright.

Re-running is cheap and safe: sessions already mined are skipped, and a proposal
you have already accepted (or accepted and later deleted) is never offered
again. `--force` overrides both.

> One `claude -p` call runs per session, each carrying ~12 KB of that
> transcript. Transcripts can contain secrets and other clients' code — the same
> trust boundary as the SessionEnd distill hook, but `--all` and `--project`
> widen it across projects, so both are explicit and `--all` asks first.

<p align="center">
  <img src="public/images/brain-graph.jpg" alt="nff-brain graph view in VS Code" width="800">
</p>

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
                  [--semantic|--lexical] [--explain]
nff-brain semantic [status|install|uninstall]
                                        manage the optional embedding runtime
nff-brain index [--force] [--check]     embed nodes for semantic search
nff-brain add --title T --content C     add a curated node
nff-brain edit <id> [--title|--content|--category]
nff-brain rm <id>                       delete a node and its links
nff-brain link <a> <b> [--strength]     connect two nodes
nff-brain reinforce <a> <b> [--delta]   strengthen a link
nff-brain unlink <a> <b>                remove a link
nff-brain merge [--ratio 0.25] [--llm]  consolidate: fold least-used nodes; --llm dedups
nff-brain recall [--query q]            print the preamble (what Claude sees)
nff-brain distill --transcript <jsonl>  distill a transcript manually
nff-brain serve [--port 7373] [--quiet] loopback server the Chrome extension pairs with
nff-brain pair [--list|--revoke <id>|--reset]
                                        open a pairing window / manage clients
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

### Chrome extension (optional)

The browser is the one place where learning evaporates. Run `nff-brain serve`,
pair the extension with the code it prints, then right-click any selected text
→ **Remember this** — it lands in a queue your next Claude Code session
distills into the brain.

Local-first by construction: the extension declares no `host_permissions` and a
`connect-src` CSP confining it to `127.0.0.1`, so Chrome itself enforces that
nothing leaves your machine. It requests four permissions, none of which shows
an install warning. Captures default to the **global** brain — a browser tab is
not "in" a project, and the global brain is merged into every recall.

See `docs/docs.md` §13 for the transport and the threat model (including what
an attacker can still do), and `packages/chrome/README.md` to build it.

### Semantic search (optional)

Search is lexical by default: great at ids and slugs, blind to paraphrase. Turn
on embeddings and it also matches meaning.

```
nff-brain semantic install    # one-time, ~400 MB runtime + ~33 MB weights
nff-brain index               # embed nodes → .nff-brain/vectors.json
nff-brain search "how much money is this actually saving me"
```

```
lex   sem   id                                   node
 ·    0.59  token-savings-counterfactual-model  [core] Model token savings as avoided rediscovery cost
```

That hit has **no** lexical overlap with the query — `·` means the lexical side
never ranked it. Results are fused by reciprocal rank, so exact id matches still
win when you type one.

This is genuinely optional and genuinely off by default: `nff-brain` itself
installs with **zero runtime dependencies**, and the embedding runtime lives in
`~/.nff-brain/runtime`, installed on demand. If it is missing or won't load on
your platform, everything silently falls back to lexical ranking — nothing
errors and no command changes its exit code. The session hooks never use it, so
recall stays fast and offline. See `docs/docs.md` §11.

## The graph model

```jsonc
{
  "version": 1,
  "nodes": [{
    "id": "docker-restart-procedure",       // kebab slug, ≤60 chars
    "title": "Docker restart procedure",
    "category": "rules",                    // core | analysis | rules | strategy
                                            // | decision | preference | task
    "content": "When containers wedge, force-recreate them because …",
    "x": 400, "y": 300, "size": 16,         // board position (the UI relaxes overlaps)
    "laidOut": true,                        // a layout pass settled this position
    "origin": "seed",                       // seed = curated · agent = distilled
                                            // graphify = codebase map · import = mined
                                            // from history · clip = browser capture
    "recallCount": 3, "lastUpdated": "…", "lastRecalledAt": "…",
    "confidence": 0.82,                     // import + skill nodes
    "sourceUrl": "…",                       // clip only
    "graphifyRef": { /* … */ },             // codebase-map drill-down
    "skill": { /* … */ }                    // place in a BRAIN-NODE.json tree
  }],
  "edges": [{ "from": "a", "to": "b", "strength": 0.8 }]   // 0..1, undirected
}
```

Curated (`seed`) nodes are never auto-evicted or auto-merged away. Learned
(`agent`) nodes are capped (400) and consolidated by folding the least-recalled
ones into their nearest neighbour — knowledge is appended, not deleted.

## Skills — BRAIN-NODE.json

A node holds one paragraph. That is the right shape for a *fact* ("when
containers wedge, force-recreate them") and the wrong shape for a *procedure
with alternatives* — there is nowhere to say "if that doesn't work, here's the
other way we know".

A **BRAIN-NODE.json** file is one skill held as a tree. Each step becomes its
own brain node, so a single branch can be corrected without rewriting the
skill; siblings marked `"kind": "alt"` are interchangeable routes to the same
sub-problem.

```jsonc
{
  "format": "brain-node", "version": 1,
  "tree": "sign-in-known-site",
  "title": "Sign in to a site I already have credentials for",
  "content": "Reach the authenticated area without asking the user to retype …",
  "when": "a page is behind a login wall and the user already has an account",
  "steps": [
    { "key": "detect", "title": "Identify which login the page offers",
      "content": "…", "verify": "you can name the auth method on the page" },
    { "key": "authenticate", "title": "Authenticate", "content": "…",
      "steps": [
        { "key": "sso", "kind": "alt", "title": "Continue with SSO",
          "content": "…", "when": "the page shows an SSO button",
          "verify": "the URL leaves the login path", "onFail": ["saved-password"] },
        { "key": "saved-password", "kind": "alt", "title": "Submit the saved password",
          "content": "…", "verify": "the URL leaves the login path" }
      ] }
  ]
}
```

```sh
nff-brain skill add skills/sign-in-known-site.BRAIN-NODE.json
nff-brain skill show sign-in-known-site      # exactly what a session will see
nff-brain skill export sign-in-known-site    # byte-identical to the input
```

Recall injects a matching skill as a rendered checklist rather than as one
bullet per step, with the alternatives listed **best-first by how often each
actually worked**:

```
### SKILL: Sign in to a site I already have credentials for
Use when: a page is behind a login wall and the user already has an account

  1. Identify which login the page offers
     …
     verify: you can name the auth method on the page
  2. Authenticate
    — either of these, in this order —
      2a. Continue with SSO                  [worked 7/8]
         …
         verify: the URL leaves the login path
      2b. Submit the saved password          [worked 1/3]
```

That ordering is the whole point of keeping a skill in the brain rather than in
a file: a branch that stops working sinks below its sibling and stays there.

Some deliberate properties:

- **A tree costs one retrieval slot, not ten.** Split across ten nodes, a skill
  would otherwise compete with itself and crowd out every other note.
- **It survives consolidation.** Skill nodes are curated (`origin: seed`) and
  are never merged, folded into, or used to absorb other nodes.
- **Re-import is an upsert.** Ids derive from `(tree, key)`, and recall counts
  and per-branch success rates carry across — so fixing one branch costs the
  tree nothing.
- **Export is byte-stable** (`skill fmt --check` enforces it), so a skill
  reviews like source. Learned counters are *not* exported: they are brain
  state, not skill definition.

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
