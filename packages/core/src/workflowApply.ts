// Commit a distilled workflow into the brain as ONE node (origin 'workflow')
// carrying the WorkflowSpec payload. A single node, not a chain of step-nodes:
// edges are undirected so step order must live in the payload regardless, and a
// workflow retracts/replaces atomically.
//
// origin 'workflow' is a trust tier, not a label: like 'clip' it stays
// retractable from the extension and is never merged or folded (a merge would
// destroy the machine payload). It has its own cap so recorded workflows never
// compete with agent knowledge for the 400-node budget.

import { removeNode, upsertEdge, upsertNode } from './brainGraph.js';
import { resolveRoot } from './spine.js';
import { placeNode, slug, type BrainFile, type BrainNode } from './types.js';
import { renderWorkflowContent, type WorkflowSpec } from './workflow.js';

/** Own budget, separate from the 400-node agent cap and the 200 clip cap. */
export const MAX_WORKFLOW_NODES = 50;

const WORKFLOW_HUB_STRENGTH = 0.3;

function workflowNodeId(base: string, taken: ReadonlySet<string>): string {
  const root = base || 'workflow';
  if (!taken.has(root)) return root;
  const withSuffix = `${root.slice(0, 51)}-flow`;
  if (!taken.has(withSuffix)) return withSuffix;
  for (let i = 2; ; i++) {
    const candidate = `${root.slice(0, 51 - String(i).length)}-flow-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ApplyWorkflowResult {
  id: string;
  evicted: string[];
}

/**
 * Upsert a workflow node from a spec + title. Prunes the least-recalled
 * workflow nodes past MAX_WORKFLOW_NODES. Links it to the graph root so it is
 * reachable in recall/graph views. `now` is injected for determinism.
 */
export function applyWorkflow(
  brain: BrainFile,
  spec: WorkflowSpec,
  title: string,
  now: Date = new Date(),
): ApplyWorkflowResult {
  const taken = new Set(brain.nodes.map((n) => n.id));
  const cleanTitle = (title || spec.intent || 'Recorded workflow').slice(0, 80);
  const baseId = slug(cleanTitle).slice(0, 55);
  const id = workflowNodeId(baseId, taken);
  const iso = now.toISOString();

  const node: BrainNode = {
    id,
    title: cleanTitle,
    category: 'strategy',
    content: renderWorkflowContent(spec),
    ...placeNode('strategy'),
    origin: 'workflow',
    sourceUrl: spec.site ? `https://${spec.site}` : undefined,
    lastUpdated: iso,
    recallCount: 0,
    workflow: spec,
  };
  upsertNode(brain, node);

  // Anchor it to the spine root so it shows up as part of the graph.
  const root = resolveRoot(brain.nodes, brain.edges);
  if (root && root !== id) upsertEdge(brain, { from: id, to: root, strength: WORKFLOW_HUB_STRENGTH });

  const evicted = pruneWorkflows(brain);
  return { id, evicted };
}

/** Evict the least-recalled workflow nodes past the cap. Returns removed ids. */
export function pruneWorkflows(brain: BrainFile): string[] {
  const flows = brain.nodes.filter((n) => n.origin === 'workflow');
  if (flows.length <= MAX_WORKFLOW_NODES) return [];
  const ordered = [...flows].sort((a, b) => {
    if (a.recallCount !== b.recallCount) return a.recallCount - b.recallCount; // least recalled first
    return a.lastUpdated < b.lastUpdated ? -1 : a.lastUpdated > b.lastUpdated ? 1 : 0; // oldest first
  });
  const removed: string[] = [];
  for (const n of ordered.slice(0, flows.length - MAX_WORKFLOW_NODES)) {
    removeNode(brain, n.id);
    removed.push(n.id);
  }
  return removed;
}
