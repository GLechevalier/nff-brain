// The gates that keep graph consolidation from quietly dismantling a skill
// tree. spine.ts's header lists the four reasons it refuses to PERSIST its
// derived tree; a skill tree is persisted because it holds real knowledge, so
// each of those hazards has to be closed deliberately.

import { describe, expect, it } from 'vitest';
import { pruneBrain } from '../src/distill.js';
import { chooseSurvivor, foldLeastUsed } from '../src/mergePass.js';
import { expandSkillFile, skillStepId } from '../src/skillApply.js';
import { parseSkillFile } from '../src/skillFile.js';
import { emptyBrain, isSkillNode, placeNode, type BrainFile, type BrainNode } from '../src/types.js';
import { CANONICAL } from './skillFixture.js';

const TREE = 'li-read-card';
const skillNodes = (): BrainNode[] => expandSkillFile(parseSkillFile(CANONICAL)).nodes;

function agentNode(id: string, opts: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: `Node ${id}`,
    category: 'strategy',
    content: `content of ${id}`,
    ...placeNode('strategy'),
    origin: 'agent',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
    ...opts,
  };
}

function brainWithSkill(extra: BrainNode[] = []): BrainFile {
  const brain = emptyBrain();
  const e = expandSkillFile(parseSkillFile(CANONICAL));
  brain.nodes.push(...e.nodes, ...extra);
  brain.edges.push(...e.edges);
  return brain;
}

describe('chooseSurvivor', () => {
  const degree = new Map<string, number>();
  const skill = () => skillNodes()[1];

  it('refuses to merge two skill steps', () => {
    // Sibling alternatives describe the SAME sub-problem in similar words, so
    // they are exactly what the trigram shortlist flags.
    const [a, b] = [skillNodes()[2], skillNodes()[3]];
    expect(chooseSurvivor(a, b, degree)).toBeNull();
  });

  it('refuses a skill/agent pair in BOTH orders', () => {
    // The pre-existing "two seeds never merge" rule does NOT cover this: a
    // skill node is origin 'seed', and seed+agent takes the `if (aSeed) return
    // [a, b]` branch, folding the agent node INTO the skill and letting the
    // merge prompt rewrite the step's title and content.
    const s = skill();
    const a = agentNode('agent-1');
    expect(chooseSurvivor(s, a, degree)).toBeNull();
    expect(chooseSurvivor(a, s, degree)).toBeNull();
  });

  it('still merges two ordinary agent nodes', () => {
    const pair = chooseSurvivor(agentNode('a'), agentNode('b'), degree);
    expect(pair).not.toBeNull();
  });

  it('CONTROL: a plain seed + agent pair does merge, seed surviving', () => {
    // Proves the previous test is not vacuous. This is the exact branch a skill
    // node would otherwise take — seed wins and absorbs the agent node — which
    // is why the skill gate has to sit ABOVE the seed checks.
    const seed = agentNode('curated', { origin: 'seed' });
    const pair = chooseSurvivor(seed, agentNode('learned'), degree);
    expect(pair).not.toBeNull();
    expect(pair![0].id).toBe('curated');

    // Same two nodes, but the survivor is now part of a tree ⇒ refused.
    const asSkill = { ...seed, skill: skillNodes()[1].skill };
    expect(chooseSurvivor(asSkill, agentNode('learned'), degree)).toBeNull();
  });
});

describe('foldLeastUsed', () => {
  it('never folds a skill node away', () => {
    const brain = brainWithSkill(Array.from({ length: 20 }, (_, i) => agentNode(`a${i}`)));
    const before = brain.nodes.filter(isSkillNode).map((n) => n.id).sort();
    foldLeastUsed(brain, 0.9);
    expect(brain.nodes.filter(isSkillNode).map((n) => n.id).sort()).toEqual(before);
  });

  it('never lets a skill node ABSORB folded content', () => {
    // mergeNodes appends the victim's text and clips at 1200 — that would
    // corrupt a step's prompt fragment and silently truncate it.
    const brain = brainWithSkill(Array.from({ length: 20 }, (_, i) => agentNode(`a${i}`)));
    const contentBefore = new Map(brain.nodes.filter(isSkillNode).map((n) => [n.id, n.content]));
    foldLeastUsed(brain, 0.9);
    for (const n of brain.nodes.filter(isSkillNode)) {
      expect(n.content).toBe(contentBefore.get(n.id));
      expect(n.content).not.toContain('---');
    }
  });

  it('still folds ordinary agent nodes', () => {
    const brain = brainWithSkill(Array.from({ length: 20 }, (_, i) => agentNode(`a${i}`)));
    expect(foldLeastUsed(brain, 0.5)).toBeGreaterThan(0);
  });
});

describe('pruneBrain', () => {
  it('never evicts a skill node past the global cap', () => {
    // Already true via origin 'seed'; pinned so a future change to the eviction
    // filter cannot silently start dismantling trees.
    const brain = brainWithSkill(Array.from({ length: 60 }, (_, i) => agentNode(`a${i}`)));
    pruneBrain(brain, 10);
    expect(brain.nodes.filter(isSkillNode)).toHaveLength(skillNodes().length);
  });
});

describe('the tree survives a full consolidation cycle', () => {
  it('keeps every step, its skillRef and its parent links', () => {
    const brain = brainWithSkill(Array.from({ length: 40 }, (_, i) => agentNode(`a${i}`)));
    foldLeastUsed(brain, 0.9);
    pruneBrain(brain, 12);

    const after = brain.nodes.filter(isSkillNode);
    expect(after).toHaveLength(5);
    for (const n of after) {
      expect(n.skill!.tree).toBe(TREE);
      expect(Array.isArray(n.skill!.path)).toBe(true);
    }
    // The parent link that makes step 2's alternatives reachable is still there.
    expect(
      brain.edges.some(
        (e) => e.from === skillStepId(TREE, 'subtitle-missing') && e.to === skillStepId(TREE, 'scroll-retry'),
      ),
    ).toBe(true);
  });
});
