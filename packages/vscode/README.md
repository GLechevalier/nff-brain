# nff-brain for VS Code

Visualize and edit your project's **nff-brain** — the local-first knowledge-graph
memory that Claude Code recalls at every session start and grows after every
session.

- Graph on the left (square nodes, pan/zoom, category glyphs ◈ ⊕ ▦ ↑), the
  selected node's **Memory Document** on the right.
- Edit, delete, and create nodes; link, unlink, and reinforce connections.
- Live updates: when a Claude Code session ends and the distiller writes new
  nodes, the open graph refreshes automatically.
- Fully offline. The brain is a JSON file in your workspace
  (`.nff-brain/brain.json`); this extension bundles all of its UI and talks to
  nothing on the network.

Pair it with the CLI (`npm i -g nff-brain`, then `nff-brain init --hooks` in
your project) to wire the Claude Code session hooks. See
[the repository](https://github.com/GLechevalier/nff-brain) for the full story.

Commands: **nff-brain: Open Brain** (editor tab), plus a Brain view in the
activity bar and a status-bar shortcut.
