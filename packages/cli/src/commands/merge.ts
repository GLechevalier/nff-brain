import {
  acquireLock,
  emptyBrain,
  foldLeastUsed,
  loadBrain,
  makeOneShot,
  mutateBrain,
  resolveBrainPaths,
  runMergePass,
  saveBrain,
} from '@nff-brain/core';
import { refreshVectors } from '../semanticRefresh.js';
import { flagNum, flagStr, parseArgs } from '../util.js';

// `nff-brain merge` — consolidate the graph.
//   default:  LLM-free fold of the least-used learned nodes into their nearest
//             neighbours (the dashboard's ⤵ Merge; knowledge kept, not deleted).
//   --llm:    additionally run the LLM-confirmed near-duplicate dedup pass.

export async function cmdMerge(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const ratio = flagNum(args, 'ratio') ?? 0.25;

  let deduped = 0;
  if (args.flags.llm === true) {
    // LLM calls are slow, so they run on a lock-free snapshot; the result is
    // written back whole (last-writer-wins for anything that raced us).
    const snapshot = loadBrain(target) ?? emptyBrain();
    if (snapshot.nodes.length >= 2) {
      console.log('checking for near-duplicates via claude -p…');
      deduped = await runMergePass(snapshot, makeOneShot({ model: flagStr(args, 'model') }), {
        threshold: 0.36,
        maxMerges: 4,
        candidateLimit: 8,
      });
      if (deduped > 0) {
        const release = acquireLock(target);
        try {
          saveBrain(target, snapshot);
        } finally {
          release();
        }
      }
    }
  }

  const folded = ratio > 0 ? mutateBrain(target, (brain) => foldLeastUsed(brain, ratio)) : 0;

  // Merging rewrites and removes nodes, so the vector sidecar is stale. No-op
  // unless the user opted into semantic search; never throws.
  if (deduped > 0 || folded > 0) {
    const vec = await refreshVectors(target);
    if (vec.ran) console.log(`re-embedded ${vec.embedded} node(s) for semantic search`);
  }

  console.log(
    `merge done: ${deduped} duplicate(s) merged${args.flags.llm ? '' : ' (dedup skipped — pass --llm)'}, ` +
      `${folded} least-used node(s) folded`,
  );
}
