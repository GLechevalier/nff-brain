import {
  DEFAULT_FANOUT,
  DEFAULT_MIN_SIM,
  buildAdjacency,
  buildSpine,
  connectedComponents,
  islandSimilarities,
  isSpineId,
  resolveRoot,
  type LayoutEdge,
} from '@nff-brain/core';
import { fail, flagNum, parseArgs } from '../util.js';
import { loadMerged } from './nodes.js';

// Print the derived navigational spine: the tree that links every island of the
// graph to one root. The spine is DERIVED — this command writes nothing. It
// exists to inspect the tree and, via --dry-run, to calibrate the clustering
// floor against a real brain instead of guessing one.

export async function cmdSpine(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const merged = loadMerged();
  if (merged.nodes.length === 0) {
    console.log('brain is empty — run `nff-brain init`');
    return;
  }

  let fanout = DEFAULT_FANOUT;
  if (args.flags.fanout !== undefined) {
    const n = flagNum(args, 'fanout');
    if (n === undefined || n < 2) fail('--fanout must be a number ≥ 2');
    fanout = Math.floor(n);
  }
  let minSim = DEFAULT_MIN_SIM;
  if (args.flags['min-sim'] !== undefined) {
    const n = flagNum(args, 'min-sim');
    if (n === undefined || n < 0 || n > 1) fail('--min-sim must be between 0 and 1');
    minSim = n;
  }

  const rootId = resolveRoot(merged.nodes, merged.edges);
  if (!rootId) fail('no root node could be resolved');
  const root = merged.nodes.find((n) => n.id === rootId)!;
  const comps = connectedComponents(merged.nodes, merged.edges);
  console.log(
    `${merged.nodes.length} node(s), ${merged.edges.length} edge(s), ${comps.length} island(s) before the spine`,
  );
  console.log(`root: ${rootId}  "${root.title}"  [${root.category}, origin=${root.origin}]`);

  // Calibration aid: how similar the islands actually are to one another. Pick
  // the floor from this, do not assume one.
  if (args.flags['dry-run'] === true) {
    const sims = islandSimilarities(merged.nodes, merged.edges, rootId);
    if (sims.length > 0) {
      const sorted = [...sims].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      console.log(
        `\nisland-pair similarity over ${sims.length} pairs: ` +
          `min ${sorted[0].toFixed(3)} · p50 ${q(0.5).toFixed(3)} · p75 ${q(0.75).toFixed(3)} · ` +
          `p90 ${q(0.9).toFixed(3)} · p99 ${q(0.99).toFixed(3)} · max ${sorted[sorted.length - 1].toFixed(3)}`,
      );
      const buckets = [0.02, 0.05, 0.08, 0.12, 0.2, 0.3];
      console.log(
        'pairs at or above: ' +
          buckets.map((b) => `${b}→${sims.filter((s) => s >= b).length}`).join('  '),
      );
    }
  }

  const spine = buildSpine(merged.nodes, merged.edges, { fanout, minSim });
  const byId = new Map(merged.nodes.map((n) => [n.id, n]));
  const spineById = new Map(spine.nodes.map((n) => [n.id, n]));
  const title = (id: string): string =>
    spineById.get(id)?.title ?? byId.get(id)?.title ?? id;

  // Render the tree. Children come from the spine edges; a spine edge always
  // points parent → child, so no direction guessing is needed here.
  const kids = new Map<string, string[]>();
  for (const e of spine.edges) (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to);
  const realAdj = buildAdjacency(merged.nodes, merged.edges);
  const islandOf = new Map<string, string[]>();
  for (const c of comps) for (const id of c) islandOf.set(id, c);

  console.log(
    `\nspine: ${spine.nodes.length} grouping node(s) linking ${spine.islandCount} island(s), fanout ${fanout}, min-sim ${minSim}`,
  );
  const line = (id: string, prefix: string, last: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    if (isSpineId(id)) {
      const s = spineById.get(id)!;
      console.log(`${branch}◇ ${s.title}  (cohesion ${s.cohesion.toFixed(3)})`);
      const indent = depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`;
      console.log(`${indent}  ${s.summary}`);
    } else {
      const size = islandOf.get(id)?.length ?? 1;
      const extra = size > 1 ? `  +${size - 1} in its island` : '';
      console.log(`${branch}${title(id)}${extra}`);
    }
    const cs = kids.get(id) ?? [];
    const nextPrefix = depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`;
    cs.forEach((c, i) => line(c, nextPrefix, i === cs.length - 1, depth + 1));
  };
  line(rootId, '', true, 0);

  // The point of the whole exercise: nothing left stranded.
  const all = [...merged.nodes.map((n) => n.id), ...spine.nodes.map((n) => n.id)];
  const combined: LayoutEdge[] = [...merged.edges, ...spine.edges];
  const adj = buildAdjacency(
    all.map((id) => ({ id })),
    combined,
  );
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!) ?? []) {
      if (seen.has(nb.id)) continue;
      seen.add(nb.id);
      stack.push(nb.id);
    }
  }
  const stranded = all.filter((id) => !seen.has(id));
  console.log(
    `\nreachable from root: ${seen.size}/${all.length}` +
      (stranded.length ? `  STRANDED: ${stranded.slice(0, 5).join(', ')}` : '  (nothing stranded)'),
  );
  if (realAdj.size === 0) console.log('note: the graph has no edges at all');
  console.log('the spine is derived — this command wrote nothing');
}
