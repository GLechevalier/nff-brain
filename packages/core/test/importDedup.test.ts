import { describe, expect, it } from 'vitest';
import {
  boostForSources,
  clusterProposals,
  emptyBrain,
  proposalHash,
  reconcileWithBrain,
  upsertNode,
  type BrainFile,
  type BrainNode,
  type ImportKind,
  type Proposal,
} from '../src/index.js';

function proposal(
  title: string,
  content: string,
  extra: Partial<Proposal> & { session?: string } = {},
): Proposal {
  const { session, ...rest } = extra;
  const kind: ImportKind = rest.kind ?? 'memory';
  return {
    kind,
    category: rest.category ?? 'strategy',
    title,
    content,
    confidence: rest.confidence ?? 0.5,
    llmConfidence: rest.llmConfidence ?? 0.5,
    sources: rest.sources ?? [{ sessionId: session ?? 's1', title: 'a session', date: '2026-08-01' }],
  };
}

function node(id: string, title: string, content: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title,
    category: 'strategy',
    content,
    color: '#a78bfa',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-08-01T00:00:00.000Z',
    recallCount: 0,
    ...extra,
  };
}

function brainWith(...nodes: BrainNode[]): BrainFile {
  const b = emptyBrain();
  for (const n of nodes) upsertNode(b, n);
  return b;
}

describe('boostForSources', () => {
  it('is monotonic, saturating and capped at 1', () => {
    expect(boostForSources(0.5, 1)).toBe(0.5);
    expect(boostForSources(0.5, 2)).toBeCloseTo(0.65, 2);
    expect(boostForSources(0.5, 3)).toBe(0.755);
    expect(boostForSources(0.5, 5)).toBeCloseTo(0.88, 2);
    expect(boostForSources(0.5, 50)).toBeLessThanOrEqual(1);
    expect(boostForSources(1, 5)).toBe(1);
    // strictly increasing
    const seq = [1, 2, 3, 4, 5].map((n) => boostForSources(0.4, n));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });
});

describe('clusterProposals', () => {
  it('folds the same lesson from five sessions into one, boosted', () => {
    const variants = [
      'Retry renameSync on EPERM on Windows',
      'Retry renameSync when it throws EPERM on Windows',
      'On Windows, retry renameSync after an EPERM error',
      'Windows: renameSync throws EPERM, so retry it',
      'Retry renameSync on Windows EPERM errors',
    ];
    const proposals = variants.map((t, i) =>
      proposal(t, 'Defender briefly locks the file, so the atomic save must retry the rename.', {
        session: `s${i}`,
        confidence: 0.5,
      }),
    );
    const [cluster, ...rest] = clusterProposals(proposals);
    expect(rest).toHaveLength(0);
    expect(cluster.sources).toHaveLength(5);
    expect(cluster.confidence).toBeCloseTo(0.88, 2);
  });

  it('keeps genuinely different lessons apart', () => {
    const out = clusterProposals([
      proposal('Retry renameSync on Windows EPERM', 'Defender locks the file briefly.'),
      proposal('Use tsup to bundle the CLI', 'Rollup needed hand-written externals config.', { session: 's2' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('never merges across kinds, however similar the wording', () => {
    const text = 'The CLI is bundled with tsup rather than rollup for the published package.';
    const out = clusterProposals([
      proposal('Bundle the CLI with tsup', text, { kind: 'decision', category: 'decision' }),
      proposal('Bundle the CLI with tsup', text, { kind: 'task', category: 'task', session: 's2' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.kind).sort()).toEqual(['decision', 'task']);
  });

  it('keeps the best-written head but takes a fuller body over a terse one', () => {
    const out = clusterProposals([
      proposal('Retry renameSync on Windows EPERM', 'Retry it.', { confidence: 0.9 }),
      proposal('Retry renameSync on Windows EPERM errors', 'Windows Defender holds a transient lock on the destination, so the atomic save has to retry the rename a few times before giving up.', {
        confidence: 0.4,
        session: 's2',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Retry renameSync on Windows EPERM'); // head's title
    expect(out[0].content).toContain('transient lock'); // fuller body
  });

  it('dedups sources so one session cannot inflate its own confidence', () => {
    const same = { sessionId: 's1', title: 't', date: '2026-08-01' };
    const out = clusterProposals([
      proposal('Retry renameSync on Windows EPERM', 'Defender locks the file.', { sources: [same] }),
      proposal('Retry renameSync on Windows EPERM again', 'Defender locks the file.', { sources: [same] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toHaveLength(1);
    expect(out[0].confidence).toBe(0.5); // no boost from a repeat within one session
  });

  it('handles an empty input', () => {
    expect(clusterProposals([])).toEqual([]);
  });
});

describe('reconcileWithBrain', () => {
  const opts = { minConfidence: 0.5 };

  it('marks a brand-new lesson new and checked when confident enough', () => {
    const [item] = reconcileWithBrain(
      brainWith(node('unrelated', 'Something else', 'Entirely different subject matter here.')),
      [proposal('Retry renameSync on Windows EPERM', 'Defender locks the file briefly.', { confidence: 0.8 })],
      opts,
    );
    expect(item.status).toBe('new');
    expect(item.checked).toBe(true);
    expect(item.id).toBe('retry-renamesync-on-windows-eperm');
  });

  it('leaves a low-confidence item present but unchecked', () => {
    const [item] = reconcileWithBrain(
      emptyBrain(),
      [proposal('Some hunch', 'Might be true.', { confidence: 0.3 })],
      opts,
    );
    expect(item.checked).toBe(false);
    expect(item.status).toBe('new');
  });

  it('refines when the slugged title hits an existing id exactly', () => {
    const brain = brainWith(node('docker-restart-procedure', 'Docker restart procedure', 'Old wording.'));
    const [item] = reconcileWithBrain(
      brain,
      [proposal('Docker restart procedure', 'Force-recreate, never restart — restart keeps the stale DNS.', { confidence: 0.9 })],
      opts,
    );
    expect(item.status).toBe('refine');
    expect(item.targetId).toBe('docker-restart-procedure');
    expect(item.previousContent).toBe('Old wording.');
    expect(item.id).toBe('docker-restart-procedure');
  });

  it('marks a near-identical restatement duplicate and unchecks it despite high confidence', () => {
    const brain = brainWith(
      node('win-rename', 'Retry renameSync on Windows EPERM', 'Defender briefly locks the file, so retry the rename.'),
    );
    const [item] = reconcileWithBrain(
      brain,
      [proposal('Retry renameSync on Windows EPERM', 'Defender briefly locks the file, so retry the rename.', { confidence: 0.95 })],
      opts,
    );
    expect(item.status).toBe('duplicate');
    expect(item.targetId).toBe('win-rename');
    expect(item.checked).toBe(false);
  });

  it('never refines a graphify node, and does not steal its id', () => {
    // graphify nodes are replaced wholesale on re-ingest, so refining one would
    // lose the edit at the next ingest. They are excluded from the match pool
    // but still OWN their id — a new item with the same slug must claim another.
    const brain = brainWith(
      node('auth-area', 'Auth area', 'The auth subsystem and its entry points.', { origin: 'graphify' }),
    );
    const [item] = reconcileWithBrain(
      brain,
      [proposal('Auth area', 'The auth subsystem and its entry points.', { confidence: 0.9 })],
      opts,
    );
    expect(item.status).toBe('new');
    expect(item.targetId).toBeUndefined();
    expect(item.id).not.toBe('auth-area'); // would have clobbered the map node
  });

  it('treats the same title with a different body as a refine, not a collision', () => {
    // Same title = same topic. Refining is what the user wants here; minting a
    // second `shared-title-2` node would fragment the knowledge.
    const brain = brainWith(node('shared-title', 'Shared title', 'Original body about networking.'));
    const [item] = reconcileWithBrain(
      brain,
      [proposal('Shared title', 'A fuller account of the same networking topic.', { confidence: 0.9 })],
      opts,
    );
    expect(item.status).toBe('refine');
    expect(item.id).toBe('shared-title');
  });

  it('drops anything the ledger has already offered', () => {
    const p = proposal('Retry renameSync on Windows EPERM', 'Defender locks the file.', { confidence: 0.9 });
    const seen = new Set([proposalHash('memory', 'Retry renameSync on Windows EPERM')]);
    expect(reconcileWithBrain(emptyBrain(), [p], { ...opts, seenHashes: seen })).toEqual([]);
  });

  it('numbers keys per kind so the preview markers are stable and short', () => {
    const items = reconcileWithBrain(
      emptyBrain(),
      [
        proposal('Alpha topic here', 'Body about alpha.', { kind: 'decision', category: 'decision' }),
        proposal('Beta topic here', 'Body about beta.', { kind: 'decision', category: 'decision' }),
        proposal('Gamma topic here', 'Body about gamma.', { kind: 'task', category: 'task' }),
      ],
      opts,
    );
    expect(items.map((i) => i.key)).toEqual(['d1', 'd2', 't1']);
  });
});
