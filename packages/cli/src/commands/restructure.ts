import {
  DEFAULT_CAP,
  DEFAULT_FLOOR,
  buildSpine,
  decodeVectors,
  loadBrain,
  loadVectors,
  mutateBrain,
  planRestructure,
  resolveBrainPaths,
  upsertEdge,
} from '@nff-brain/core';
import { fail, flagNum, parseArgs, type Args } from '../util.js';

// Improve the graph's REAL structure so the spine has less to invent.
//
// This is a BACKFILL: importApply already links similar nodes, but only at the
// moment a node is created and only against what existed then. Running that
// same rule across the whole brain finds the pairs it never got to compare.
//
// Preview by default, `--apply` to write — the same shape as `import`, because
// this creates real edges in a knowledge graph and should never be a surprise.

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

export async function cmdRestructure(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const file = targetPath(args);

  let floor = DEFAULT_FLOOR;
  if (args.flags.floor !== undefined) {
    const n = flagNum(args, 'floor');
    if (n === undefined || n <= 0 || n > 1) fail('--floor must be between 0 and 1');
    floor = n;
  }
  let cap = DEFAULT_CAP;
  if (args.flags.cap !== undefined) {
    const n = flagNum(args, 'cap');
    if (n === undefined || n < 1) fail('--cap must be a positive number');
    cap = Math.floor(n);
  }

  const brain = loadBrain(file);
  if (!brain || brain.nodes.length === 0) {
    console.log(`nothing to restructure — ${file} is empty or missing`);
    return;
  }

  // Use embeddings when this brain has been indexed; skip silently otherwise.
  const vf = loadVectors(file);
  const vectors = vf ? decodeVectors(vf) : null;

  const plan = planRestructure(brain.nodes, brain.edges, { floor, cap, vectors });

  console.log(`${brain.nodes.length} node(s), ${brain.edges.length} edge(s) in ${file}`);
  console.log(
    `islands ${plan.islandsBefore} (largest ${plan.largestBefore}, ${plan.singletonsBefore} singleton(s))`,
  );
  console.log(
    plan.semanticUsed
      ? 'semantic: using the indexed vectors alongside trigram'
      : 'semantic: not indexed for this brain — trigram only (run `semantic install` then `index`)',
  );

  // The curve is the point of the preview: there IS a cliff, and picking a
  // floor without seeing where it sits is how a graph turns back into a hairball.
  console.log('\n  floor | new edges | islands | largest | singletons');
  for (const p of plan.curve) {
    const mark = Math.abs(p.floor - floor) < 1e-9 ? ' <- selected' : '';
    console.log(
      `   ${p.floor.toFixed(2)} |    ${String(p.edges).padStart(4)}   |   ${String(p.islands).padStart(3)}   |   ${String(p.largest).padStart(3)}   |     ${String(p.singletons).padStart(2)}${mark}`,
    );
  }
  const collapse = plan.curve.find((p) => p.largest > brain.nodes.length * 0.8);
  if (collapse) {
    console.log(
      `  ⚠ at floor ${collapse.floor.toFixed(2)} one component swallows ${collapse.largest}/${brain.nodes.length} nodes — that is the hairball, not a structure`,
    );
  }

  if (plan.candidates.length === 0) {
    console.log('\nno cross-island pairs clear the floor — nothing to do');
    return;
  }

  const byId = new Map(brain.nodes.map((n) => [n.id, n]));
  const title = (id: string) => byId.get(id)?.title ?? id;
  console.log(`\n${plan.candidates.length} edge(s) at floor ${floor}, cap ${cap}:`);
  for (const c of plan.candidates) {
    const via = c.via === 'semantic' ? ' [semantic]' : '';
    console.log(`  ${c.sim.toFixed(3)}${via}  ${title(c.from)}\n         ↔  ${title(c.to)}`);
  }

  const spineBefore = buildSpine(brain.nodes, brain.edges);
  const spineAfter = buildSpine(brain.nodes, [
    ...brain.edges,
    ...plan.candidates.map((c) => ({ from: c.from, to: c.to, strength: c.sim })),
  ]);
  console.log(
    `\nislands ${plan.islandsBefore} → ${plan.islandsAfter}` +
      `  ·  largest ${plan.largestBefore} → ${plan.largestAfter}` +
      `  ·  singletons ${plan.singletonsBefore} → ${plan.singletonsAfter}`,
  );
  console.log(
    `spine grouping nodes ${spineBefore.nodes.length} → ${spineAfter.nodes.length}` +
      ` (less invented structure is the whole point)`,
  );

  if (args.flags.apply !== true) {
    console.log('\npreview only — nothing written. Re-run with --apply to create these edges.');
    return;
  }

  let written = 0;
  mutateBrain(file, (b) => {
    const ids = new Set(b.nodes.map((n) => n.id));
    for (const c of plan.candidates) {
      // A node may have been deleted between the plan and the lock.
      if (!ids.has(c.from) || !ids.has(c.to)) continue;
      upsertEdge(b, { from: c.from, to: c.to, strength: Number(c.sim.toFixed(2)) });
      written++;
    }
  });
  console.log(`\nwrote ${written} edge(s) to ${file}`);
  console.log('run `nff-brain layout --full` to re-settle the tree around the new structure');
}
