import { cmdDistill } from './commands/distill.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdLink, cmdReinforce, cmdUnlink } from './commands/edges.js';
import { cmdInstallHooks, cmdUninstallHooks } from './commands/hooks.js';
import { cmdInit } from './commands/init.js';
import { cmdMerge } from './commands/merge.js';
import { cmdAdd, cmdEdit, cmdList, cmdRm, cmdShow } from './commands/nodes.js';
import { cmdRecall } from './commands/recall.js';

const HELP = `nff-brain — local-first knowledge-graph memory for Claude Code

usage: nff-brain <command> [options]

setup
  init [--hooks] [--global]        create the brain; ingest CLAUDE.md/AGENTS.md via claude -p
  install-hooks [--global]         wire SessionStart recall + SessionEnd distill into .claude/settings.json
  uninstall-hooks [--global]       remove exactly the nff-brain hook entries
  doctor                           check claude CLI, brain files, locks, hooks

session loop (normally run by the hooks)
  recall [--query q] [--stdin-hook]      print the recalled preamble (LLM-free, fail-open)
  distill [--transcript p] [--stdin-hook] distill a session transcript into nodes (one claude -p call)

graph
  list                             all nodes (merged project + global view)
  show <id>                        one node's memory document
  add --title T --content C [--category core|analysis|rules|strategy] [--id i]
  edit <id> [--title T] [--content C] [--category c]
  rm <id>                          delete a node and its edges
  link <a> <b> [--strength 0.6]    connect two nodes
  unlink <a> <b>                   remove a connection
  reinforce <a> <b> [--delta 0.1]  strengthen a connection
  merge [--ratio 0.25] [--llm]     fold least-used nodes into neighbours; --llm also dedups

Writes target <workspace>/.nff-brain/brain.json; add --global for ~/.nff-brain/brain.json.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  init: cmdInit,
  recall: cmdRecall,
  distill: cmdDistill,
  'install-hooks': cmdInstallHooks,
  'uninstall-hooks': cmdUninstallHooks,
  list: () => cmdList(),
  show: cmdShow,
  add: cmdAdd,
  edit: cmdEdit,
  rm: cmdRm,
  link: cmdLink,
  unlink: cmdUnlink,
  reinforce: cmdReinforce,
  merge: cmdMerge,
  doctor: () => cmdDoctor(),
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
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
