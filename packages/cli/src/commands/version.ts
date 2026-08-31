import * as os from 'node:os';
import {
  commitBrain,
  checkoutBrain,
  createBranch,
  loadCommits,
  loadRefs,
  makeOneShot,
  mergeBranch,
  pushBranch,
  resolveBrainPaths,
} from '@nff-brain/core';
import { fail, flagStr, parseArgs, type Args } from '../util.js';

// `nff-brain commit` / `branch` / `checkout` / `log` / `merge-branch` — the
// git-like layer on top of brain.json. `merge-branch` is named apart from the
// existing `merge` (node consolidation/dedup) so the two never collide.

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

function defaultAuthor(): string {
  return process.env.NFF_BRAIN_AUTHOR ?? os.userInfo().username;
}

export async function cmdCommit(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const author = flagStr(args, 'author') ?? defaultAuthor();
  const message = flagStr(args, 'message');
  const oneShot = args.flags['no-llm'] === true ? undefined : makeOneShot({ model: flagStr(args, 'model') });
  const commit = await commitBrain(target, { author, message, oneShot });
  if (!commit) {
    console.log('nothing to commit — brain.json matches HEAD');
    return;
  }
  console.log(`[${commit.branch} ${commit.id.slice(-8)}] ${commit.message}`);
}

export async function cmdBranch(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const [name] = args.positional;
  if (!name) {
    const refs = loadRefs(target);
    for (const [branch, head] of Object.entries(refs.branches)) {
      console.log(`${branch === refs.HEAD ? '*' : ' '} ${branch} (${head.slice(-8)})`);
    }
    return;
  }
  const from = flagStr(args, 'from');
  try {
    createBranch(target, name, from);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`created branch "${name}"${from ? ` from ${from}` : ''}`);
}

export async function cmdCheckout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const [ref] = args.positional;
  if (!ref) fail('usage: nff-brain checkout <branch-or-commit>');
  try {
    const { refs } = checkoutBrain(target, ref);
    console.log(`checked out "${refs.HEAD}"`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export async function cmdLog(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const refs = loadRefs(target);
  const branchFilter = flagStr(args, 'branch');
  const commits = loadCommits(target)
    .filter((c) => !branchFilter || c.branch === branchFilter)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!commits.length) {
    console.log('no commits yet');
    return;
  }
  for (const c of commits) {
    const merge = c.parents.length > 1 ? ' (merge)' : '';
    console.log(`${c.id.slice(-8)} [${c.branch}]${merge} ${c.message}  — ${c.author}, ${c.ts}`);
  }
  console.log(`HEAD -> ${refs.HEAD}`);
}

export async function cmdPush(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const token = flagStr(args, 'token') ?? process.env.NFF_BRAIN_COMPANY_SYNC_TOKEN;
  if (!token) {
    fail(
      'no sync token — pass --token or set NFF_BRAIN_COMPANY_SYNC_TOKEN ' +
        '(an admin mints one in nff-admin\'s Users tab)',
    );
  }
  const url = flagStr(args, 'url') ?? process.env.NFF_BRAIN_COMPANY_SYNC_URL;
  const branch = flagStr(args, 'branch');
  try {
    const result = await pushBranch(target, { token, url, branch });
    if (result.pushed === 0) {
      console.log('nothing to push — already up to date');
      return;
    }
    console.log(`pushed ${result.pushed} commit(s)${result.merged ? ' (merged into company main)' : ''}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export async function cmdMergeBranch(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = targetPath(args);
  const [source] = args.positional;
  if (!source) fail('usage: nff-brain merge-branch <branch> [--into target] [--llm]');
  const author = flagStr(args, 'author') ?? defaultAuthor();
  const oneShot = args.flags.llm === true ? makeOneShot({ model: flagStr(args, 'model') }) : undefined;
  try {
    const outcome = await mergeBranch(target, source, {
      author,
      oneShot,
      targetBranch: flagStr(args, 'into'),
    });
    if (!outcome.commit) {
      console.log(`nothing to merge — already up to date with "${source}"`);
      return;
    }
    console.log(`[merge ${outcome.commit.id.slice(-8)}] ${outcome.commit.message}`);
    if (outcome.conflicts.length) {
      const resolvedBy = args.flags.llm === true ? 'LLM-resolved' : "kept 'ours' — pass --llm to auto-resolve";
      console.log(`${outcome.conflicts.length} conflict(s), ${resolvedBy}: ${outcome.conflicts.map((c) => c.id).join(', ')}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
