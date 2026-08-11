import { appendActivity, rankNodes, resolveBrainPaths } from '@nff-brain/core';
import { fail, flagNum, parseArgs } from '../util.js';
import { loadMerged } from './nodes.js';

// `nff-brain search <query>` — rank nodes in the merged project + global view.

export async function cmdSearch(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const query = args.positional.join(' ').trim();
  if (!query) fail('usage: nff-brain search <query> [--limit 10]');
  const merged = loadMerged();
  if (merged.nodes.length === 0) {
    console.log('brain is empty — run `nff-brain init`');
    return;
  }
  const ranked = rankNodes(query, merged.nodes, { limit: flagNum(args, 'limit') ?? 10 });
  if (ranked.length === 0) {
    console.log(`(no matches for "${query}")`);
    return;
  }
  appendActivity(resolveBrainPaths(process.cwd()).project, {
    kind: 'search',
    ids: ranked.map((r) => r.node.id),
  });
  const width = Math.min(40, Math.max(...ranked.map((r) => r.node.id.length)) + 2);
  for (const { node, score } of ranked) {
    console.log(`${score.toFixed(2)}  ${node.id.padEnd(width)} [${node.category}] ${node.title}`);
  }
}
