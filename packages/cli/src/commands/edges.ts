import {
  clampStrength,
  mutateBrain,
  resolveBrainPaths,
  upsertEdge,
} from '@nff-brain/core';
import { fail, flagNum, parseArgs, type Args } from '../util.js';

// Edge ops: link / unlink / reinforce. Both endpoints must live in the target
// file (project by default, --global for the global brain).

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

function requireIds(args: Args, usage: string): [string, string] {
  const [a, b] = args.positional;
  if (!a || !b) fail(usage);
  return [a, b];
}

export async function cmdLink(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [a, b] = requireIds(args, 'usage: nff-brain link <a> <b> [--strength 0.6]');
  const strength = clampStrength(flagNum(args, 'strength') ?? 0.6);
  mutateBrain(targetPath(args), (brain) => {
    const ids = new Set(brain.nodes.map((n) => n.id));
    if (!ids.has(a)) fail(`no node "${a}" in this brain file (try --global?)`);
    if (!ids.has(b)) fail(`no node "${b}" in this brain file (try --global?)`);
    if (a === b) fail('cannot link a node to itself');
    upsertEdge(brain, { from: a, to: b, strength });
  });
  console.log(`linked ${a} ↔ ${b} (${strength.toFixed(2)})`);
}

export async function cmdUnlink(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [a, b] = requireIds(args, 'usage: nff-brain unlink <a> <b>');
  const removed = mutateBrain(targetPath(args), (brain) => {
    const before = brain.edges.length;
    brain.edges = brain.edges.filter(
      (e) => !((e.from === a && e.to === b) || (e.from === b && e.to === a)),
    );
    return before - brain.edges.length;
  });
  if (!removed) fail(`no edge between "${a}" and "${b}"`);
  console.log(`unlinked ${a} ↔ ${b}`);
}

export async function cmdReinforce(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [a, b] = requireIds(args, 'usage: nff-brain reinforce <a> <b> [--delta 0.1]');
  const delta = flagNum(args, 'delta') ?? 0.1;
  const strength = mutateBrain(targetPath(args), (brain) => {
    const edge = brain.edges.find(
      (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
    );
    if (!edge) fail(`no edge between "${a}" and "${b}" — use \`link ${a} ${b}\` first`);
    edge.strength = clampStrength(edge.strength + delta);
    return edge.strength;
  });
  console.log(`reinforced ${a} ↔ ${b} → ${strength.toFixed(2)}`);
}
