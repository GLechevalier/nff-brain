
<p align="center">
  <img src="public/images/tumbnail.png" alt="nff" width="640">
</p>

# nff-brain, local infra for knowledge graphs your agents share

**Record it once. Rerun it forever — and it gets better every time you do.**

 `nff-brain` is brain infra: a local knowledge graph store, shared by a CLI, a VS Code extension, and a Chrome extension, that grows from what you
  do in your browser and your coding sessions — then hands that back to you and your agents.

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="https://github.com/GLechevalier/nff-brain/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/GLechevalier/nff-brain/ci.yml?branch=main&label=CI"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white">
</p>

What it does : it runs a shared brain graph on your machine, grown automatically from your CLI, editor, and browser sessions, and it lets you automate web tasks on top of it :

- **Local only.** : the graph store runs locally, connected to claude code or your own API keys — only ever on your computer
- **Connects to your local claude code so that you don't burn too much API tokens** : litteraly linkable to your claude code terminal if you want to run it besides it, or just use an API key
- **General context integrated** : the more you use any of the CLI, VS Code, or Chrome front ends, the more context accumulates in the shared graph, and it self-improves your tool
- **Automate web tasks** : a recorder makes your brain grow smarter, and you can ask it to replay actions that you already did by the past. Think Zapier/n8n but self-configured.
- **Connects with other MCP tools** : let you output things foundout during runs to mcp tools to store data or make decisions on other systems


## Install

  - **Chrome extension** — load unpacked from `packages/chrome/dist` for now (Web Store listing pending); see `packages/chrome/README.md` for
  the manual checklist.
  - **CLI** — `npm i -g nff-brain` once published; until then, `npm pack -w nff-brain` and install the tarball locally.
  - **VS Code** — install the `.vsix` from `packages/vscode` (`vsce package --no-dependencies`).

Then hook it into Claude Code:

nff-brain install-hooks --apply-model

That's it — the graph starts empty and grows from whatever you capture and whatever your agent sessions distill.

## Docs

  Full mechanics — hooks, the novelty-driven model ladder, the clip pipeline, BYOK standalone mode — live in `docs/docs.md`.

  Two things worth deciding before you ship this: whether the CLI is actually published yet (the install section above hedges on that — fix it
  to whichever is true), and whether you want the "Coming next" section this candid in a public README versus holding the replay-engine framing
  for launch, once it's closer to real.

<p align="center">
  <img src="public/images/brain-graph.jpg" alt="nff-brain graph view in VS Code" width="800">
</p>

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
