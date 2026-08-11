import { cmdDistill } from './commands/distill.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdLink, cmdReinforce, cmdUnlink } from './commands/edges.js';
import { cmdInstallHooks, cmdUninstallHooks } from './commands/hooks.js';
import { cmdExpand, cmdIngestGraphify } from './commands/ingestGraphify.js';
import { cmdInit } from './commands/init.js';
import { cmdMerge } from './commands/merge.js';
import { cmdAdd, cmdEdit, cmdList, cmdRm, cmdShow } from './commands/nodes.js';
import { cmdNovelty } from './commands/novelty.js';
import { cmdRecall } from './commands/recall.js';
import { cmdSearch } from './commands/search.js';
import { cmdUpgrade } from './commands/upgrade.js';
import { cliVersion } from './util.js';

const HELP = `nff-brain — local-first knowledge-graph memory for Claude Code

usage: nff-brain <command> [options]

setup
  init [--hooks] [--global]        create the brain; ingest CLAUDE.md/AGENTS.md via claude -p
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

graph
  list                             all nodes (merged project + global view)
  search <query> [--limit 10]      rank nodes by relevance to a query
  show <id>                        one node's memory document
  add --title T --content C [--category core|analysis|rules|strategy] [--id i]
  edit <id> [--title T] [--content C] [--category c]
  rm <id>                          delete a node and its edges
  link <a> <b> [--strength 0.6]    connect two nodes
  unlink <a> <b>                   remove a connection
  reinforce <a> <b> [--delta 0.1]  strengthen a connection
  merge [--ratio 0.25] [--llm]     fold least-used nodes into neighbours; --llm also dedups

codebase map (graphify bridge)
  ingest-graphify [--dir graphify-out] [--max-per-repo 10] [--no-llm]
                                   import a graphify graph as ≤10 intent nodes per repo
  expand <id>                      list a codebase-map node's underlying code entities

Writes target <workspace>/.nff-brain/brain.json; add --global for ~/.nff-brain/brain.json.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  init: cmdInit,
  recall: cmdRecall,
  distill: cmdDistill,
  novelty: cmdNovelty,
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
