import {
  asCategory,
  loadBrain,
  mergeBrains,
  mutateBrain,
  placeNode,
  removeNode,
  resolveBrainPaths,
  slug,
  upsertNode,
  type BrainNode,
} from '@nff-brain/core';
import { fail, flagStr, parseArgs, type Args } from '../util.js';

// Node CRUD: list / show <id> / add / edit <id> / rm <id>.
// Reads look at the MERGED graph (project + global); writes target the project
// file unless --global.

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

function loadMerged() {
  const paths = resolveBrainPaths(process.cwd());
  const project = (() => {
    try {
      return loadBrain(paths.project);
    } catch {
      return null;
    }
  })();
  const global = (() => {
    try {
      return loadBrain(paths.global);
    } catch {
      return null;
    }
  })();
  return mergeBrains(project, global);
}

export async function cmdList(): Promise<void> {
  const merged = loadMerged();
  if (merged.nodes.length === 0) {
    console.log('brain is empty — run `nff-brain init`');
    return;
  }
  const width = Math.min(40, Math.max(...merged.nodes.map((n) => n.id.length)) + 2);
  for (const n of [...merged.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const deg = merged.edges.filter((e) => e.from === n.id || e.to === n.id).length;
    const src = merged.sourceById.get(n.id) === 'global' ? 'G' : 'P';
    console.log(
      `${n.id.padEnd(width)} [${n.category}] ${src} deg=${deg} recalls=${n.recallCount ?? 0}  ${n.title}`,
    );
  }
  console.log(`\n${merged.nodes.length} node(s), ${merged.edges.length} edge(s)`);
}

export async function cmdShow(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const id = args.positional[0] ?? fail('usage: nff-brain show <id>');
  const merged = loadMerged();
  const node = merged.nodes.find((n) => n.id === id) ?? fail(`no node "${id}"`);
  const related = merged.edges
    .filter((e) => e.from === id || e.to === id)
    .map((e) => `${e.from === id ? e.to : e.from} (${e.strength.toFixed(2)})`);
  console.log(`[${node.category}] ${node.title}`);
  console.log(`id: ${node.id}  origin: ${node.origin}  source: ${merged.sourceById.get(id)}`);
  console.log(`updated: ${node.lastUpdated}  recalls: ${node.recallCount ?? 0}`);
  console.log(`\n${node.content}`);
  if (related.length) console.log(`\nrelated: ${related.join(', ')}`);
}

export async function cmdAdd(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const title = flagStr(args, 'title') ?? fail('usage: nff-brain add --title T --content C [--category rules] [--id my-id]');
  const content = flagStr(args, 'content') ?? fail('--content is required');
  const category = asCategory(flagStr(args, 'category'));
  const id = slug(flagStr(args, 'id') ?? title) || fail('could not derive an id — pass --id');
  mutateBrain(targetPath(args), (brain) => {
    const existing = brain.nodes.find((n) => n.id === id);
    if (existing) fail(`node "${id}" already exists — use \`edit ${id}\``);
    const node: BrainNode = {
      id,
      title: title.slice(0, 80),
      category,
      content: content.slice(0, 1200),
      ...placeNode(category),
      origin: 'seed', // hand-authored knowledge is curated
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    };
    upsertNode(brain, node);
  });
  console.log(`added ${id}`);
}

export async function cmdEdit(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const id = args.positional[0] ?? fail('usage: nff-brain edit <id> [--title T] [--content C] [--category c]');
  const title = flagStr(args, 'title');
  const content = flagStr(args, 'content');
  const category = flagStr(args, 'category');
  if (!title && !content && !category) fail('nothing to change — pass --title / --content / --category');
  mutateBrain(targetPath(args), (brain) => {
    const node = brain.nodes.find((n) => n.id === id) ?? fail(`no node "${id}" in this brain file (try --global?)`);
    if (title) node.title = title.slice(0, 80);
    if (content) node.content = content.slice(0, 1200);
    if (category) node.category = asCategory(category);
    node.lastUpdated = new Date().toISOString();
  });
  console.log(`updated ${id}`);
}

export async function cmdRm(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const id = args.positional[0] ?? fail('usage: nff-brain rm <id>');
  const removed = mutateBrain(targetPath(args), (brain) => removeNode(brain, id));
  if (!removed) fail(`no node "${id}" in this brain file (try --global?)`);
  console.log(`removed ${id} (and its edges)`);
}
