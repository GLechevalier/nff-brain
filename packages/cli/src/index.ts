import { cmdDistill } from './commands/distill.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdLink, cmdReinforce, cmdUnlink } from './commands/edges.js';
import { cmdInstallHooks, cmdUninstallHooks } from './commands/hooks.js';
import { cmdImport } from './commands/import.js';
import { cmdIndex } from './commands/indexVectors.js';
import { cmdExpand, cmdIngestGraphify } from './commands/ingestGraphify.js';
import { cmdInit } from './commands/init.js';
import { cmdLayout } from './commands/layout.js';
import { cmdRestructure } from './commands/restructure.js';
import { cmdSpine } from './commands/spine.js';
import { cmdMerge } from './commands/merge.js';
import { cmdAdd, cmdEdit, cmdList, cmdRm, cmdShow } from './commands/nodes.js';
import { cmdNovelty } from './commands/novelty.js';
import { cmdModel } from './commands/model.js';
import { cmdPair } from './commands/pair.js';
import { cmdRecall } from './commands/recall.js';
import { cmdSearch } from './commands/search.js';
import { cmdSemantic } from './commands/semantic.js';
import { cmdServe } from './commands/serve.js';
import { cmdUpgrade } from './commands/upgrade.js';
import { cliVersion } from './util.js';

const HELP = `nff-brain — local-first knowledge-graph memory for Claude Code

usage: nff-brain <command> [options]

setup
  init [--hooks] [--global] [--import]
                                   create the brain; ingest CLAUDE.md/AGENTS.md via claude -p
  import                           bare, in a terminal: interactive wizard — scan, pick scope and
                                   time range, watch the mining live, review and apply in place
  import [--limit 40] [--since 7d] [--all] [--project P] [--min-confidence 0.5]
         [--concurrency 4] [--model m] [--force] [--yes] [--no-interactive]
                                   mine PAST Claude Code sessions for durable memories, decisions,
                                   preferences, open tasks and past failures → .nff-brain/import-preview.md
                                   (writes nothing to the brain; sends transcript excerpts to claude -p;
                                   any flag, a pipe, or --no-interactive skips the wizard)
  import --apply [--max-new 60] [--force]
                                   commit the items still checked in that preview
  install-hooks [--global] [--apply-model] [--auto-model]
                                   wire SessionStart recall + SessionEnd distill into .claude/settings.json
                                   --apply-model  let the prompt hook write the chosen tier into
                                                  .claude/settings.local.json — the only thing that actually
                                                  changes the model (applies to the NEXT session, no prompt).
                                                  Upgrades an already-installed prompt hook in place
                                   --auto-model   DEPRECATED: have the VS Code extension type /model into a
                                                  terminal. Needs claudeCode.useTerminal (not the default) and
                                                  triggers Claude's mid-session switch confirmation
  uninstall-hooks [--global]       remove exactly the nff-brain hook entries
  doctor                           check claude CLI, brain files, locks, hooks
  upgrade                          npm install -g nff-brain@latest
  --version                        print the CLI version

session loop (normally run by the hooks)
  recall [--query q] [--stdin-hook]      print the recalled preamble (LLM-free, fail-open)
  distill [--transcript p] [--stdin-hook] distill a session transcript into nodes (one claude -p call)
  novelty [--query q] [--json] [--stdin-hook]
                                   score how novel a task is vs the brain → suggested session model
                                   (weak/uncovered nodes → frontier model, strong nodes → cheap model)
  model [--write] [--query q] [--from-score] [--json]
                                   which tier the NEXT session should launch on; --write applies it
                                   to .claude/settings.local.json (Claude Code binds the model at
                                   session creation — nothing can retier a running session)

graph
  list                             all nodes (merged project + global view)
  search <query> [--limit 10] [--semantic|--lexical] [--explain]
                                   rank nodes by relevance to a query; hybrid lexical +
                                   embedding similarity when semantic search is enabled
  show <id>                        one node's memory document
  add --title T --content C [--category core|analysis|rules|strategy|decision|preference|task] [--id i]
  edit <id> [--title T] [--content C] [--category c]
  rm <id>                          delete a node and its edges
  link <a> <b> [--strength 0.6]    connect two nodes
  unlink <a> <b>                   remove a connection
  reinforce <a> <b> [--delta 0.1]  strengthen a connection
  merge [--ratio 0.25] [--llm]     fold least-used nodes into neighbours; --llm also dedups
  layout [--full] [--iterations 300] [--no-spine] [--dry-run]
                                   settle node positions with the force-directed layout, so
                                   connected nodes sit together and each disconnected component
                                   becomes its own island. Incremental by default: nodes already
                                   laid out keep their coordinates and only new ones are placed.
                                   --full re-settles everything as a radial tree along the spine
                                   (--no-spine falls back to packing the islands side by side)
  restructure [--floor 0.4] [--cap 2] [--apply] [--global]
                                   link islands that SHOULD already be linked, so the graph itself
                                   gets better and the spine has less to invent. A backfill: the
                                   importer links similar nodes only at creation time, against what
                                   existed then — this runs that same rule across the whole brain.
                                   Preview by default; prints the floor→islands curve (there is a
                                   cliff — below it everything collapses into one blob) and uses
                                   embeddings too when the brain has been indexed
  spine [--fanout 7] [--min-sim 0.08] [--dry-run]
                                   print the navigational spine — the derived tree that links every
                                   island of the graph to one root, through grouping nodes that
                                   split further whenever a node would carry more than --fanout
                                   children. DERIVED: nothing is ever written to the brain.
                                   --dry-run also prints the island-similarity distribution, which
                                   is how you pick --min-sim for YOUR brain rather than guessing

semantic search (optional — search works without it)
  semantic [status|install|uninstall]
                                   manage the local embedding runtime (~400 MB, one-time,
                                   installed into ~/.nff-brain/runtime — never a package dep)
  index [--global] [--all] [--force] [--check] [--json]
                                   embed nodes into .nff-brain/vectors.json (only stale ones)

codebase map (graphify bridge)
  ingest-graphify [--dir graphify-out] [--max-per-repo 10] [--no-llm]
                                   import a graphify graph as ≤10 intent nodes per repo
  expand <id>                      list a codebase-map node's underlying code entities

browser (Chrome extension transport)
  serve [--port 7373] [--target global|project] [--allow-origin o] [--quiet]
                                   loopback HTTP server the Chrome extension pairs with;
                                   captures land in a clip queue the next session drains.
                                   Foreground — Ctrl-C stops it
  pair [--list] [--revoke <id>] [--reset]
                                   open a 5-minute pairing window and print the code;
                                   --reset revokes every client and rotates the server
                                   identity (works with the server down)

Writes target <workspace>/.nff-brain/brain.json; add --global for ~/.nff-brain/brain.json.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  init: cmdInit,
  import: cmdImport,
  recall: cmdRecall,
  distill: cmdDistill,
  novelty: cmdNovelty,
  model: cmdModel,
  'install-hooks': cmdInstallHooks,
  'uninstall-hooks': cmdUninstallHooks,
  list: () => cmdList(),
  search: cmdSearch,
  show: cmdShow,
  add: cmdAdd,
  edit: cmdEdit,
  rm: cmdRm,
  link: cmdLink,
  unlink: cmdUnlink,
  reinforce: cmdReinforce,
  merge: cmdMerge,
  layout: cmdLayout,
  spine: cmdSpine,
  restructure: cmdRestructure,
  semantic: cmdSemantic,
  index: cmdIndex,
  'ingest-graphify': cmdIngestGraphify,
  expand: cmdExpand,
  serve: cmdServe,
  pair: cmdPair,
  doctor: () => cmdDoctor(),
  upgrade: () => cmdUpgrade(),
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`nff-brain: unknown command "${cmd}" — see \`nff-brain help\``);
    process.exit(1);
  }
  await fn(rest);
}

// Exit explicitly once the command finishes (after flushing stdout): hook
// invocations must never linger, even if a stray handle survives a timeout.
function flushExit(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

main()
  .then(() => flushExit(0))
  .catch((err) => {
    console.error(`nff-brain: ${err instanceof Error ? err.message : String(err)}`);
    flushExit(1);
  });
