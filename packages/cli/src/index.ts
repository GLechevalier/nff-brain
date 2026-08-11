import { cmdDistill } from './commands/distill.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdLink, cmdReinforce, cmdUnlink } from './commands/edges.js';
import { cmdInstallHooks, cmdUninstallHooks } from './commands/hooks.js';
import { cmdImport } from './commands/import.js';
import { cmdIndex } from './commands/indexVectors.js';
import { cmdExpand, cmdIngestGraphify } from './commands/ingestGraphify.js';
import { cmdInit } from './commands/init.js';
import { cmdMerge } from './commands/merge.js';
import { cmdAdd, cmdEdit, cmdList, cmdRm, cmdShow } from './commands/nodes.js';
import { cmdNovelty } from './commands/novelty.js';
import { cmdModel } from './commands/model.js';
import { cmdRecall } from './commands/recall.js';
import { cmdSearch } from './commands/search.js';
import { cmdSemantic } from './commands/semantic.js';
import { cmdUpgrade } from './commands/upgrade.js';
import { cliVersion } from './util.js';

const HELP = `nff-brain — local-first knowledge-graph memory for Claude Code

usage: nff-brain <command> [options]

setup
  init [--hooks] [--global] [--import]
                                   create the brain; ingest CLAUDE.md/AGENTS.md via claude -p
  import [--limit 40] [--since 7d] [--all] [--project P] [--min-confidence 0.5]
         [--concurrency 4] [--model m] [--force] [--yes]
                                   mine PAST Claude Code sessions for durable memories, decisions,
                                   preferences, open tasks and past failures → .nff-brain/import-preview.md
                                   (writes nothing to the brain; sends transcript excerpts to claude -p)
  import --apply [--max-new 60] [--force]
                                   commit the items still checked in that preview
  install-hooks [--global] [--auto-model]
                                   wire SessionStart recall + SessionEnd distill into .claude/settings.json;
                                   --auto-model also wires UserPromptSubmit novelty scoring (model switching)
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
  semantic: cmdSemantic,
  index: cmdIndex,
  'ingest-graphify': cmdIngestGraphify,
  expand: cmdExpand,
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
