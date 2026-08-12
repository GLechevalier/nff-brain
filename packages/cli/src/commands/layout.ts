import {
  buildSpine,
  connectedComponents,
  layoutBrain,
  loadBrain,
  mutateBrain,
  resolveBrainPaths,
  type BrainNode,
} from '@nff-brain/core';
import { fail, flagNum, parseArgs, type Args } from '../util.js';

// Settle node positions with the force-directed layout, so connectivity drives
// geometry instead of placeNode()'s Math.random(). Each connected component is
// laid out separately and the results are packed with gutters, which is what
// makes the graph's islands read as distinct subregions.

function targetPath(args: Args): string {
  const paths = resolveBrainPaths(process.cwd());
  return args.flags.global === true ? paths.global : paths.project;
}

export async function cmdLayout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const file = targetPath(args);
  const full = args.flags.full === true;
  const dryRun = args.flags['dry-run'] === true;

  let iterations: number | undefined;
  if (args.flags.iterations !== undefined) {
    const n = flagNum(args, 'iterations');
    if (n === undefined || n < 1) fail('--iterations must be a positive number');
    iterations = Math.floor(n);
  }

  const brain = (() => {
    try {
      return loadBrain(file);
    } catch (err) {
      fail(`cannot read ${file}: ${(err as Error).message}`);
    }
  })();
  if (!brain || brain.nodes.length === 0) {
    console.log(`nothing to lay out — ${file} is empty or missing`);
    return;
  }

  const comps = connectedComponents(brain.nodes, brain.edges);
  const unsettled = brain.nodes.filter((n) => !n.laidOut).length;
  // Nothing settled yet ⇒ there is no arrangement to preserve, so this is a
  // full pass whether or not --full was passed (layoutBrain agrees).
  const effectivelyFull = full || unsettled === brain.nodes.length;
  console.log(
    `${brain.nodes.length} node(s), ${brain.edges.length} edge(s), ` +
      `${comps.length} component(s): ${comps
        .slice(0, 12)
        .map((c) => c.length)
        .join(',')}${comps.length > 12 ? ',…' : ''}`,
  );

  if (!full && unsettled === 0) {
    console.log('every node is already laid out — nothing to do (use --full to re-settle)');
    return;
  }

  // The spine turns the islands into one radial tree. It is derived and costs
  // nothing to rebuild, so it is computed here rather than stored.
  const spine = args.flags['no-spine'] === true ? null : buildSpine(brain.nodes, brain.edges);
  if (spine && spine.islandCount > 0) {
    console.log(
      `spine: ${spine.nodes.length} grouping node(s) linking ${spine.islandCount} island(s) to ${spine.rootId}`,
    );
  }

  // Compute OUTSIDE the lock: the force pass is pure and can take a moment on a
  // large brain, and holding the brain lock across it would stall the hooks.
  const pos = layoutBrain(brain.nodes, brain.edges, {
    incremental: !effectivelyFull,
    iterations,
    spine,
  });

  const extent = boundsOf(brain.nodes, pos);
  console.log(
    effectivelyFull
      ? `settled all ${brain.nodes.length} node(s)${full ? '' : ' (nothing was laid out yet)'}`
      : `settled ${unsettled} new node(s); ${brain.nodes.length - unsettled} kept in place`,
  );
  console.log(
    `extent ${Math.round(extent.width)} x ${Math.round(extent.height)} px ` +
      `centred on (${Math.round(extent.cx)}, ${Math.round(extent.cy)})`,
  );

  if (dryRun) {
    console.log('--dry-run: nothing written');
    return;
  }

  let applied = 0;
  let vanished = 0;
  mutateBrain(file, (b) => {
    for (const node of b.nodes) {
      const p = pos[node.id];
      // A node added between the read and the lock has no computed position —
      // leave it alone rather than guessing; the next pass will settle it.
      if (!p) {
        vanished++;
        continue;
      }
      node.x = p.x;
      node.y = p.y;
      node.laidOut = true;
      applied++;
    }
  });

  console.log(`wrote ${applied} position(s) to ${file}`);
  if (vanished > 0) {
    console.log(`${vanished} node(s) appeared mid-run and were left for the next pass`);
  }
}

function boundsOf(
  nodes: readonly BrainNode[],
  pos: Record<string, { x: number; y: number }>,
): { width: number; height: number; cx: number; cy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    minX = Math.min(minX, p.x - n.size);
    minY = Math.min(minY, p.y - n.size);
    maxX = Math.max(maxX, p.x + n.size);
    maxY = Math.max(maxY, p.y + n.size);
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0, cx: 0, cy: 0 };
  return {
    width: maxX - minX,
    height: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}
