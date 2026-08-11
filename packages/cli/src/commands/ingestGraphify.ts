import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyExplanations,
  applyGraphifyImport,
  buildExplainPrompt,
  buildGraphifyImport,
  expandGraphifyRef,
  loadBrain,
  makeOneShot,
  mergeBrains,
  mutateBrain,
  parseCommunityLabels,
  parseGraphifyGraph,
  resolveBrainPaths,
  type CommunityLabel,
  type GraphifyGraph,
} from '@nff-brain/core';
import { fail, flagNum, flagStr, parseArgs } from '../util.js';

// `nff-brain ingest-graphify` — compress a graphify knowledge graph
// (graphify-out/graph.json) into at most --max-per-repo codebase-map nodes per
// repo, each explained by one batched claude -p call (intent, fail-open) and
// linked back to its graphify children via graphifyRef.
//
// `nff-brain expand <id>` — the drill-down bridge: list a codebase-map node's
// underlying code entities live from graph.json.

export async function cmdIngestGraphify(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;

  const dir = path.resolve(flagStr(args, 'dir') ?? path.join(process.cwd(), 'graphify-out'));
  const graphFile = path.join(dir, 'graph.json');
  if (!fs.existsSync(graphFile)) {
    fail(`no graph.json in ${dir} — run /graphify first, or point at it with --dir`);
  }

  let graph: GraphifyGraph;
  try {
    graph = parseGraphifyGraph(fs.readFileSync(graphFile, 'utf8'));
  } catch (err) {
    fail(`could not read ${graphFile}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let labels = new Map<number, CommunityLabel>();
  const reportFile = path.join(dir, 'GRAPH_REPORT.md');
  try {
    if (fs.existsSync(reportFile)) labels = parseCommunityLabels(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    // report is optional — fall back to derived titles
  }

  // Store the graph path relative to the workspace root so the brain stays portable.
  const relGraph = path.relative(paths.workspaceRoot, graphFile).split(path.sep).join('/');
  const imported = buildGraphifyImport(graph, labels, {
    maxPerRepo: flagNum(args, 'max-per-repo') ?? 10,
    graphPath: relGraph.startsWith('..') ? graphFile.split(path.sep).join('/') : relGraph,
  });
  if (imported.nodes.length === 0) {
    fail('nothing to import — the graph has no usable communities, hubs, or hyperedges');
  }

  // Intent explanations: one batched call, strictly fail-open.
  let intentSource = 'mechanical summaries (--no-llm)';
  if (args.flags['no-llm'] !== true) {
    try {
      const oneShot = makeOneShot({ model: flagStr(args, 'model') });
      const applied = applyExplanations(imported.nodes, await oneShot(buildExplainPrompt(imported.subjects)));
      intentSource = applied > 0 ? `LLM intent on ${applied}/${imported.nodes.length} nodes` : 'mechanical summaries (explainer returned no usable JSON)';
    } catch (err) {
      intentSource = `mechanical summaries (claude -p failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const { removed } = mutateBrain(target, (brain) => applyGraphifyImport(brain, imported));

  const count = (prefix: string): number => imported.nodes.filter((n) => n.id.startsWith(prefix)).length;
  console.log(
    `imported ${count('gf-area-')} area(s), ${count('gf-god-')} god node(s), ${count('gf-flow-')} flow(s) ` +
      `(+${imported.edges.length} edges); replaced ${removed} previous graphify node(s); ${intentSource}`,
  );
  for (const [repo, { kept, total }] of Object.entries(imported.perRepo)) {
    if (total > kept) console.log(`  ${repo}: kept ${kept} of ${total} candidates`);
  }
}

export async function cmdExpand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const rawId = args.positional[0];
  if (!rawId) fail('usage: nff-brain expand <node-id>');

  const paths = resolveBrainPaths(process.cwd());
  const merged = mergeBrains(loadBrain(paths.project), loadBrain(paths.global));
  const node =
    merged.nodes.find((n) => n.id === rawId) ?? merged.nodes.find((n) => n.id === `gf-${rawId}`);
  if (!node) fail(`no node "${rawId}" — see \`nff-brain list\``);
  if (!node.graphifyRef) fail(`node ${node.id} has no graphify link — only ingest-graphify nodes can be expanded`);

  const ref = node.graphifyRef;
  const graphFile = path.isAbsolute(ref.graph) ? ref.graph : path.join(paths.workspaceRoot, ref.graph);
  if (!fs.existsSync(graphFile)) {
    fail(`graphify graph not found at ${graphFile} — re-run /graphify, then nff-brain ingest-graphify`);
  }
  let graph: GraphifyGraph;
  try {
    graph = parseGraphifyGraph(fs.readFileSync(graphFile, 'utf8'));
  } catch (err) {
    fail(`could not read ${graphFile}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { children, internalLinks, missing } = expandGraphifyRef(ref, graph);
  console.log(`${node.title} — ${ref.kind} ${ref.key} (${children.length} entities)`);
  for (const c of children) {
    console.log(`  ${c.label}${c.sourceFile ? ` — ${c.sourceFile}` : ''}${c.fileType ? ` (${c.fileType})` : ''}`);
  }
  if (internalLinks.length) {
    console.log('relations:');
    const byId = new Map(graph.nodes.map((n) => [n.id, n.label]));
    for (const l of internalLinks.slice(0, 30)) {
      console.log(`  ${byId.get(l.source)} -${l.relation}-> ${byId.get(l.target)}`);
    }
    if (internalLinks.length > 30) console.log(`  … ${internalLinks.length - 30} more`);
  }
  if (missing > 0) {
    console.log(`note: ${missing} child node(s) no longer in the graph — re-run ingest-graphify to refresh`);
  }
}
