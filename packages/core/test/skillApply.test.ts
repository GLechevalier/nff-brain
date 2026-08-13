import { describe, expect, it } from 'vitest';
import {
  applySkillFile,
  collapseSkillNodes,
  expandSkillFile,
  relinkSkillTree,
  skillConfidence,
  skillRootId,
  skillStepId,
  SKILL_EDGE_ALT,
  SKILL_EDGE_HUB,
  SKILL_EDGE_PARENT,
} from '../src/skillApply.js';
import { parseSkillFile, serializeSkillFile, SkillFileError } from '../src/skillFile.js';
import { emptyBrain, placeNode, type BrainFile, type BrainNode } from '../src/types.js';
import { CANONICAL } from './skillFixture.js';

const file = () => parseSkillFile(CANONICAL);
const TREE = 'li-read-card';

function seeded(): BrainFile {
  const brain = emptyBrain();
  applySkillFile(brain, expandSkillFile(file()), {});
  return brain;
}

function node(brain: BrainFile, id: string): BrainNode {
  const n = brain.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

describe('expandSkillFile', () => {
  it('mints one node per step plus a root', () => {
    const e = expandSkillFile(file());
    expect(e.nodes).toHaveLength(5); // root + 2 steps + 2 alts
    expect(e.rootId).toBe('sk-li-read-card');
    expect(e.nodes.map((n) => n.id)).toContain('sk-li-read-card-scroll-retry');
  });

  it('keeps every id inside slug()\'s 60-char cap at the declared maximums', () => {
    // The cap is why keys must be unique tree-wide: the id uses the leaf key
    // alone, so it never has to carry the full path or a dedupe suffix.
    const tree = 'a'.repeat(32);
    const key = 'b'.repeat(20);
    expect(skillRootId(tree).length).toBeLessThanOrEqual(60);
    expect(skillStepId(tree, key).length).toBeLessThanOrEqual(60);
    expect(skillStepId(tree, key)).toBe(`sk-${tree}-${key}`);
  });

  it('marks every node strategy/seed so existing eviction exemptions apply', () => {
    for (const n of expandSkillFile(file()).nodes) {
      expect(n.category).toBe('strategy');
      // origin 'seed' is load-bearing: pruneBrain and foldLeastUsed already
      // exempt seeds, so no eviction path needs to learn what a skill is.
      expect(n.origin).toBe('seed');
      expect(n.skill?.tree).toBe(TREE);
    }
  });

  it('mirrors when/verify/tags into content so the frozen scoreNode can see them', () => {
    const e = expandSkillFile(file());
    const root = e.nodes.find((n) => n.skill!.kind === 'root')!;
    expect(root.content).toContain('When: the plan is on an evaluateCards step');
    expect(root.content).toContain('Tags: linkedin, people-search, card');
    const step = e.nodes.find((n) => n.id === skillStepId(TREE, 'scroll-retry'))!;
    expect(step.content).toContain('Verify: the subtitle now splits');
  });

  it('records the path, kind and sibling order', () => {
    const e = expandSkillFile(file());
    const alt = e.nodes.find((n) => n.id === skillStepId(TREE, 'open-profile'))!;
    expect(alt.skill).toMatchObject({
      tree: TREE,
      path: ['subtitle-missing', 'open-profile'],
      kind: 'alt',
      order: 1,
    });
  });

  it('emits parent links and chains the alternatives', () => {
    const e = expandSkillFile(file());
    const parent = e.edges.find(
      (x) => x.from === skillStepId(TREE, 'subtitle-missing') && x.to === skillStepId(TREE, 'scroll-retry'),
    );
    expect(parent?.strength).toBe(SKILL_EDGE_PARENT);
    const alt = e.edges.find(
      (x) => x.from === skillStepId(TREE, 'scroll-retry') && x.to === skillStepId(TREE, 'open-profile'),
    );
    expect(alt?.strength).toBe(SKILL_EDGE_ALT);
  });

  it('refuses content that would overflow the node cap once when/verify are mirrored', () => {
    // Silently clipping would corrupt the round trip; the author is told instead.
    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    (doc.steps as Array<Record<string, unknown>>)[0].content = 'x'.repeat(1190);
    expect(() => expandSkillFile(parseSkillFile(JSON.stringify(doc)))).toThrow(/over the 1200 node limit/);
  });
});

describe('applySkillFile', () => {
  it('writes the tree and links the root to the hub when it would be an island', () => {
    const brain = emptyBrain();
    const hub: BrainNode = {
      id: 'the-project',
      title: 'Project',
      category: 'core',
      content: 'hub',
      ...placeNode('core'),
      origin: 'seed',
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    };
    brain.nodes.push(hub);
    applySkillFile(brain, expandSkillFile(file()), {});
    const hubEdge = brain.edges.find((e) => e.from === 'the-project' && e.to === skillRootId(TREE));
    expect(hubEdge?.strength).toBe(SKILL_EDGE_HUB);
  });

  it('is an idempotent upsert — re-applying adds nothing', () => {
    const brain = seeded();
    const before = brain.nodes.length;
    const r = applySkillFile(brain, expandSkillFile(file(), { existing: brain.nodes }), {});
    expect(brain.nodes).toHaveLength(before);
    expect(r.created).toEqual([]);
    expect(r.updated).toHaveLength(before);
  });

  it('carries learned state and board position across a re-import', () => {
    // This is the whole point of "change only one specific part": correcting a
    // branch must not cost the tree its measured history.
    const brain = seeded();
    const target = node(brain, skillStepId(TREE, 'scroll-retry'));
    target.recallCount = 9;
    target.lastRecalledAt = '2026-01-01T00:00:00.000Z';
    target.skill!.outcome = { tried: 4, worked: 3, failed: 1 };
    target.x = 123;
    target.y = 456;

    applySkillFile(brain, expandSkillFile(file(), { existing: brain.nodes }), {});
    const after = node(brain, skillStepId(TREE, 'scroll-retry'));
    expect(after.recallCount).toBe(9);
    expect(after.lastRecalledAt).toBe('2026-01-01T00:00:00.000Z');
    expect(after.skill!.outcome).toEqual({ tried: 4, worked: 3, failed: 1 });
    expect(after.x).toBe(123);
    expect(after.confidence).toBeCloseTo(4 / 6, 6); // Laplace (worked+1)/(tried+2)
  });

  it('removes steps the file no longer declares, scoped to that tree alone', () => {
    const brain = seeded();
    const other: BrainNode = {
      id: 'unrelated',
      title: 'Unrelated',
      category: 'strategy',
      content: 'x',
      ...placeNode('strategy'),
      origin: 'agent',
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    };
    brain.nodes.push(other);

    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    (doc.steps as unknown[]).pop(); // drop subtitle-missing and its two alts
    const r = applySkillFile(brain, expandSkillFile(parseSkillFile(JSON.stringify(doc)), { existing: brain.nodes }), {});

    expect(r.removed.sort()).toEqual(
      [skillStepId(TREE, 'subtitle-missing'), skillStepId(TREE, 'scroll-retry'), skillStepId(TREE, 'open-profile')].sort(),
    );
    expect(brain.nodes.find((n) => n.id === 'unrelated')).toBeDefined();
  });

  it('reports a conflict and writes NOTHING when an id is held by a non-skill node', () => {
    const brain = emptyBrain();
    brain.nodes.push({
      id: skillStepId(TREE, 'read-subtitle'),
      title: 'Someone else',
      category: 'analysis',
      content: 'mine',
      ...placeNode('analysis'),
      origin: 'agent',
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    });
    const r = applySkillFile(brain, expandSkillFile(file()), {});
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].heldBy).toMatch(/agent node/);
    expect(brain.nodes).toHaveLength(1); // untouched
    expect(node(brain, skillStepId(TREE, 'read-subtitle')).title).toBe('Someone else');
  });

  it('--force overwrites the conflicting id', () => {
    const brain = emptyBrain();
    brain.nodes.push({
      id: skillStepId(TREE, 'read-subtitle'),
      title: 'Someone else',
      category: 'analysis',
      content: 'mine',
      ...placeNode('analysis'),
      origin: 'agent',
      lastUpdated: new Date().toISOString(),
      recallCount: 0,
    });
    applySkillFile(brain, expandSkillFile(file()), { force: true });
    expect(node(brain, skillStepId(TREE, 'read-subtitle')).title).toBe('Read the subtitle line as it stands');
  });
});

describe('collapseSkillNodes', () => {
  it('round-trips expand → collapse → serialize byte for byte', () => {
    expect(serializeSkillFile(collapseSkillNodes(seeded().nodes, TREE))).toBe(CANONICAL);
  });

  it('still round-trips after usage has written learned state', () => {
    // Runtime state is brain state, not skill definition — exporting it would
    // make every export a diff.
    const brain = seeded();
    const n = node(brain, skillStepId(TREE, 'open-profile'));
    n.recallCount = 12;
    n.skill!.outcome = { tried: 3, worked: 0, failed: 3 };
    n.confidence = 0.2;
    expect(serializeSkillFile(collapseSkillNodes(brain.nodes, TREE))).toBe(CANONICAL);
  });

  it('rebuilds sibling order from SkillRef.order, not array order', () => {
    const brain = seeded();
    brain.nodes.reverse();
    expect(serializeSkillFile(collapseSkillNodes(brain.nodes, TREE))).toBe(CANONICAL);
  });

  it('refuses a tree that is not there', () => {
    expect(() => collapseSkillNodes(seeded().nodes, 'nope')).toThrow(SkillFileError);
  });
});

describe('relinkSkillTree', () => {
  it('restores a parent link deleted out from under the tree', () => {
    // The VS Code editor rebuilds a node's edges from its markdown link list,
    // so deleting a link line silently drops one. The tree survives because
    // topology lives in skill.path — this is the repair.
    const brain = seeded();
    brain.edges = brain.edges.filter(
      (e) => !(e.from === skillStepId(TREE, 'subtitle-missing') && e.to === skillStepId(TREE, 'scroll-retry')),
    );
    expect(relinkSkillTree(brain, TREE)).toBeGreaterThan(0);
    expect(
      brain.edges.find(
        (e) => e.from === skillStepId(TREE, 'subtitle-missing') && e.to === skillStepId(TREE, 'scroll-retry'),
      ),
    ).toBeDefined();
  });
});

describe('skillConfidence', () => {
  it('is undefined until something was actually tried', () => {
    expect(skillConfidence(undefined)).toBeUndefined();
    expect(skillConfidence({ tried: 0, worked: 0, failed: 0 })).toBeUndefined();
  });

  it('ranks a branch that worked above one that did not', () => {
    const good = skillConfidence({ tried: 4, worked: 4, failed: 0 })!;
    const bad = skillConfidence({ tried: 4, worked: 0, failed: 4 })!;
    expect(good).toBeGreaterThan(bad);
  });
});
