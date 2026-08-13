// `nff-brain skill` — BRAIN-NODE.json skill trees.
//
// A skill file is a curated, reviewable artefact: `add` expands it into one
// brain node per step, `export` collapses it back byte-stably, and re-running
// `add` upserts rather than duplicating (ids are a pure function of tree+key).
// Learned state — recallCount and the per-branch outcome counters that order
// the alternatives — is carried across a re-import, which is what makes
// "correct one branch" cheap.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendActivity,
  applySkillFile,
  collapseSkillNodes,
  expandSkillFile,
  groupSkillNodes,
  loadBrain,
  mutateBrain,
  parseSkillFile,
  relinkSkillTree,
  renderSkillBlock,
  resolveBrainPaths,
  serializeSkillFile,
  type BrainNode,
} from '@nff-brain/core';
import { refreshVectors } from '../semanticRefresh.js';
import { loadMerged } from './nodes.js';
import { fail, flagStr, parseArgs, type Args } from '../util.js';

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

function readFileOrFail(file: string): string {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) fail(`no such file: ${abs}`);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    fail(`could not read ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Skill nodes of one tree, from the merged project+global view. */
function treeNodes(tree: string): BrainNode[] {
  return loadMerged().nodes.filter((n) => n.skill?.tree === tree);
}

function cmdAdd(args: Args): void {
  const file = args.positional[0];
  if (!file) fail('usage: nff-brain skill add <file.BRAIN-NODE.json> [--global] [--force] [--dry-run]');

  const parsed = parseSkillFile(readFileOrFail(file));
  const target = targetPath(args);
  const paths = resolveBrainPaths(process.cwd());
  const rel = path.relative(paths.workspaceRoot, path.resolve(process.cwd(), file)).split(path.sep).join('/');

  const existing = (() => {
    try {
      return loadBrain(target)?.nodes ?? [];
    } catch {
      return [];
    }
  })();
  const expansion = expandSkillFile(parsed, { source: rel, existing });

  if (args.flags['dry-run'] === true) {
    process.stdout.write(`${parsed.title}\n  tree ${parsed.tree} — ${expansion.nodes.length} node(s), ${expansion.edges.length} edge(s)\n\n`);
    for (const n of expansion.nodes) {
      const ref = n.skill!;
      const where = ref.path.length ? ref.path.join(' › ') : '(root)';
      process.stdout.write(`  ${n.id.padEnd(40)} ${ref.kind.padEnd(5)} ${where}\n`);
    }
    process.stdout.write('\nnothing written (--dry-run)\n');
    return;
  }

  const result = mutateBrain(target, (brain) =>
    applySkillFile(brain, expansion, { force: args.flags.force === true }),
  );

  if (result.conflicts.length > 0) {
    console.error(`nff-brain: ${result.conflicts.length} id(s) are already taken by something else:`);
    for (const c of result.conflicts) console.error(`  ${c.id} — held by ${c.heldBy}`);
    fail('nothing was written. Rename those step keys, or re-run with --force to overwrite.');
  }

  refreshVectors(target);
  const bits = [`${result.created.length} created`, `${result.updated.length} updated`];
  if (result.removed.length) bits.push(`${result.removed.length} removed`);
  process.stdout.write(`skill "${parsed.tree}" — ${bits.join(', ')}\n`);
}

function cmdList(): void {
  const merged = loadMerged();
  const groups = groupSkillNodes(merged.nodes);
  if (groups.length === 0) {
    process.stdout.write('no skill trees — add one with `nff-brain skill add <file.BRAIN-NODE.json>`\n');
    return;
  }
  for (const g of groups.sort((a, b) => a.tree.localeCompare(b.tree))) {
    const all = [...(g.root ? [g.root] : []), ...g.steps];
    const depth = Math.max(0, ...all.map((n) => (n.skill?.path ?? []).length));
    const alts = g.steps.filter((n) => n.skill?.kind === 'alt').length;
    const recalls = all.reduce((s, n) => s + (n.recallCount ?? 0), 0);
    process.stdout.write(
      `${g.tree.padEnd(24)} ${String(all.length).padStart(3)} nodes  depth ${depth}  ${String(alts).padStart(2)} alts  ` +
        `${String(recalls).padStart(4)} recalls  ${g.root?.title ?? '(no root)'}\n`,
    );
  }
}

function cmdShow(args: Args): void {
  const tree = args.positional[0];
  if (!tree) fail('usage: nff-brain skill show <tree> [--json]');
  const nodes = treeNodes(tree);
  if (nodes.length === 0) fail(`no skill tree "${tree}" — see \`nff-brain skill list\``);

  if (args.flags.json === true) {
    process.stdout.write(serializeSkillFile(collapseSkillNodes(nodes, tree)));
    return;
  }
  const [group] = groupSkillNodes(nodes);
  process.stdout.write(`${renderSkillBlock(group)}\n`);
  // Light the tree up in the graph webview, as `expand` does for codebase maps.
  try {
    appendActivity(resolveBrainPaths(process.cwd()).project, {
      kind: 'expand',
      ids: nodes.map((n) => n.id),
    });
  } catch {
    /* activity is decoration — never fail a read on it */
  }
}

function cmdExport(args: Args): void {
  const tree = args.positional[0];
  if (!tree) fail('usage: nff-brain skill export <tree> [--out FILE]');
  const nodes = treeNodes(tree);
  if (nodes.length === 0) fail(`no skill tree "${tree}" — see \`nff-brain skill list\``);

  const text = serializeSkillFile(collapseSkillNodes(nodes, tree));
  const out = flagStr(args, 'out');
  if (!out) {
    process.stdout.write(text);
    return;
  }
  const abs = path.resolve(process.cwd(), out);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  process.stdout.write(`wrote ${abs}\n`);
}

function cmdRelink(args: Args): void {
  const tree = args.positional[0];
  if (!tree) fail('usage: nff-brain skill relink <tree> [--global]');
  const target = targetPath(args);
  const n = mutateBrain(target, (brain) => relinkSkillTree(brain, tree));
  if (n === 0) fail(`no skill tree "${tree}" in ${target}`);
  process.stdout.write(`re-emitted ${n} parent link(s) for "${tree}"\n`);
}

function cmdFmt(args: Args): void {
  const file = args.positional[0];
  if (!file) fail('usage: nff-brain skill fmt <file.BRAIN-NODE.json> [--check]');
  const abs = path.resolve(process.cwd(), file);
  const raw = readFileOrFail(file);
  const canonical = serializeSkillFile(parseSkillFile(raw));

  if (args.flags.check === true) {
    if (raw === canonical) {
      process.stdout.write(`${file} is canonical\n`);
      return;
    }
    fail(`${file} is not canonical — run \`nff-brain skill fmt ${file}\``);
  }
  if (raw === canonical) {
    process.stdout.write(`${file} already canonical\n`);
    return;
  }
  fs.writeFileSync(abs, canonical);
  process.stdout.write(`formatted ${abs}\n`);
}

const USAGE = `usage: nff-brain skill <add|list|show|export|relink|fmt> …

  add <file.json> [--global] [--force] [--dry-run]   expand a tree into the brain (idempotent)
  list                                               every tree, with size, depth and recalls
  show <tree> [--json]                               print it as recall renders it
  export <tree> [--out FILE]                         collapse back to BRAIN-NODE.json
  relink <tree> [--global]                           re-emit parent links from skill.path
  fmt <file.json> [--check]                          canonicalize key order and indentation
`;

export async function cmdSkill(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  switch (sub) {
    case 'add':
      return cmdAdd(args);
    case 'list':
      return cmdList();
    case 'show':
      return cmdShow(args);
    case 'export':
      return cmdExport(args);
    case 'relink':
      return cmdRelink(args);
    case 'fmt':
      return cmdFmt(args);
    default:
      process.stdout.write(USAGE);
      if (sub) process.exit(1);
  }
}
