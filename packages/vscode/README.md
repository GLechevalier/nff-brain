# nff-brain for VS Code

Visualize and edit your project's **nff-brain** — the local-first knowledge-graph
memory that Claude Code recalls at every session start and grows after every
session.

- Full-width graph (square nodes, pan/zoom, category glyphs ◈ ⊕ ▦ ↑, search).
- Click a node and it opens as a **real markdown editor tab** beside the graph
  (`nffbrain:` virtual files). Edit the title, category, body, or the
  `## Links` list and save — everything writes back into the brain. `[[id]]`
  references are Ctrl+clickable.
- Create nodes from the toolbar (＋ Node), delete via `nff-brain: Delete Node…`.
- Live updates: when a Claude Code session ends and the distiller writes new
  nodes, the open graph refreshes automatically.
- Fully offline. The brain is a JSON file in your workspace
  (`.nff-brain/brain.json`); this extension bundles all of its UI and talks to
  nothing on the network.

Pair it with the CLI (`npm i -g nff-brain`, then `nff-brain init --hooks` in
your project) to wire the Claude Code session hooks. See
[the repository](https://github.com/GLechevalier/nff-brain) for the full story.

Commands: **nff-brain: Open Brain** opens the graph as a full editor tab; the
status-bar `brain` item is a one-click shortcut to the same tab.
