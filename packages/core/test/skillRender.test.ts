import { describe, expect, it } from 'vitest';
import { buildChatPrompt, expandSkillHits, groupSkillNodes, renderSkillBlock } from '../src/chatPrompt.js';
import { recallBrain } from '../src/recall.js';
import { expandSkillFile, skillStepId } from '../src/skillApply.js';
import { parseSkillFile } from '../src/skillFile.js';
import { placeNode, type BrainNode } from '../src/types.js';
import { CANONICAL } from './skillFixture.js';

const TREE = 'li-read-card';
const tree = (): BrainNode[] => expandSkillFile(parseSkillFile(CANONICAL)).nodes;

function flat(id: string, title: string, content: string): BrainNode {
  return {
    id,
    title,
    category: 'strategy',
    content,
    ...placeNode('strategy'),
    origin: 'agent',
    lastUpdated: new Date().toISOString(),
    recallCount: 0,
  };
}

function block(nodes: BrainNode[] = tree()): string {
  return renderSkillBlock(groupSkillNodes(nodes)[0]);
}

describe('renderSkillBlock', () => {
  it('renders a procedure, not a bullet per node', () => {
    const out = block();
    expect(out).toContain('### SKILL: Read role and company off a LinkedIn result card');
    expect(out).toContain('Use when: the plan is on an evaluateCards step');
    expect(out).toContain('Done when: every card has a role and company');
    expect(out).toContain('1. Read the subtitle line as it stands');
    expect(out).toContain('2. The subtitle is blank or unsplittable');
  });

  it('marks alternatives as alternatives — the whole point of the format', () => {
    const out = block();
    expect(out).toContain('— either of these, in this order —');
    // Alternatives take the PARENT's number with a letter: 2a, 2b.
    expect(out).toContain('2a. Scroll the card into view and re-read');
    expect(out).toContain('2b. Open the profile and read the headline');
  });

  it('resolves onFail to a sibling TITLE, never a key', () => {
    const out = block();
    expect(out).toContain('if this fails, try: "Open the profile and read the headline"');
    expect(out).not.toContain('onFail');
    expect(out).not.toContain('open-profile');
  });

  it('never leaks a node id — a model given one will cite nodes it never saw', () => {
    const out = block();
    for (const n of tree()) expect(out).not.toContain(n.id);
  });

  it('does not repeat the When:/Verify:/Tags: tail that content mirrors for scoring', () => {
    const out = block();
    // The tail exists on the node so the frozen scoreNode can match it, but the
    // renderer prints those fields from SkillRef — printing both says it twice.
    expect(out).not.toContain('Tags: linkedin');
    expect(out.match(/the plan is on an evaluateCards step/g)).toHaveLength(1);
  });

  it('gives the preferred alternative a full body and the rest a one-liner', () => {
    // The fallbacks must stay VISIBLE up front — a model that sees them before
    // it commits chooses better — without burying the route that usually works.
    const nodes = tree();
    const preferred = nodes.find((n) => n.id === skillStepId(TREE, 'scroll-retry'))!;
    const fallback = nodes.find((n) => n.id === skillStepId(TREE, 'open-profile'))!;
    // ~215 chars: comfortably inside the preferred body's 400 budget, well past
    // the 160 an alternative gets.
    const long = (tag: string) => `${tag} ${'padding words here '.repeat(10)}END-${tag}`;
    preferred.content = long('PREFERRED');
    fallback.content = long('FALLBACK');

    const out = block(nodes);
    expect(out).toContain(preferred.title);
    expect(out).toContain(fallback.title);
    // Preferred gets the 400-char budget; the fallback gets 160, so only the
    // preferred one's tail survives.
    expect(out).toContain('END-PREFERRED');
    expect(out).not.toContain('END-FALLBACK');
    expect(out).toContain('FALLBACK padding words');
  });

  it('orders alternatives by measured success, not authored order', () => {
    // The learning loop, as one assertion: a branch that keeps failing drops
    // below its sibling and is offered second next time.
    const nodes = tree();
    const scroll = nodes.find((n) => n.id === skillStepId(TREE, 'scroll-retry'))!;
    const profile = nodes.find((n) => n.id === skillStepId(TREE, 'open-profile'))!;
    scroll.skill!.outcome = { tried: 5, worked: 0, failed: 5 };
    scroll.confidence = 1 / 7;
    profile.skill!.outcome = { tried: 5, worked: 5, failed: 0 };
    profile.confidence = 6 / 7;

    const out = block(nodes);
    expect(out.indexOf('Open the profile')).toBeLessThan(out.indexOf('Scroll the card into view'));
    expect(out).toContain('[worked 5/5]');
    expect(out).toContain('[worked 0/5]');
    // The authored onFail pointed at "open-profile", which measurement has now
    // promoted ABOVE this branch. Repeating it would send the reader in a
    // circle, so a hint that no longer points forward is dropped.
    expect(out).not.toContain('if this fails, try:');
  });

  it('keeps authored order while a branch is unmeasured', () => {
    const out = block();
    expect(out.indexOf('Scroll the card into view')).toBeLessThan(out.indexOf('Open the profile'));
    expect(out).not.toContain('[worked');
  });
});

describe('buildChatPrompt with skills', () => {
  const ask = (nodes: BrainNode[]) =>
    buildChatPrompt({
      message: 'how do I read a card',
      history: [],
      nodes: nodes.map((n) => ({ id: n.id, title: n.title, content: n.content, ...(n.skill ? { skill: n.skill } : {}) })),
    });

  it('is byte-identical to the pre-skill output when no skill node is present', () => {
    // The regression guard for "additive": every existing caller must be
    // unaffected.
    const nodes = [flat('n1', 'Alpha', 'aaa'), flat('n2', 'Beta', 'bbb')];
    const p = ask(nodes);
    expect(p).toContain('RELEVANT NOTES FROM THE BRAIN:');
    expect(p).toContain('#0 "Alpha": aaa');
    expect(p).toContain('#1 "Beta": bbb');
    expect(p).not.toContain('SKILLS YOU HAVE');
  });

  it('puts the skill section before the flat notes', () => {
    const p = ask([...tree(), flat('n1', 'Alpha', 'aaa')]);
    expect(p.indexOf('SKILLS YOU HAVE')).toBeLessThan(p.indexOf('RELEVANT NOTES FROM THE BRAIN:'));
    expect(p).toContain('### SKILL:');
    expect(p).toContain('#0 "Alpha": aaa');
  });

  it('does not claim nothing matched when only a skill matched', () => {
    const p = ask(tree());
    expect(p).not.toContain('no notes in the brain matched');
    expect(p).toContain('### SKILL:');
  });

  it('still leaks no node id', () => {
    const p = ask([...tree(), flat('n1', 'Alpha', 'aaa')]);
    for (const n of tree()) expect(p).not.toContain(n.id);
  });
});

describe('expandSkillHits', () => {
  it('collapses a skill hit to its whole tree in one slot', () => {
    // A mid-tree hit must drag in its root; otherwise the model gets step 2 of
    // a procedure with nothing to hang it off.
    const nodes = tree();
    const midHit = nodes.find((n) => n.id === skillStepId(TREE, 'scroll-retry'))!;
    const { skills, plain } = expandSkillHits(nodes, [midHit]);
    expect(plain).toEqual([]);
    expect(skills).toHaveLength(nodes.length);
    expect(skills[0].skill!.kind).toBe('root');
  });

  it('orders members ancestors-first so a slice can never orphan a step', () => {
    const nodes = tree();
    const { skills } = expandSkillHits(nodes, [nodes[0]], { maxNodesPerTree: 3 });
    const depths = skills.map((n) => n.skill!.path.length);
    expect([...depths]).toEqual([...depths].sort((a, b) => a - b));
    expect(skills).toHaveLength(3);
  });

  it('keeps plain hits separate and does not let one skill take every slot', () => {
    const nodes = [...tree(), flat('n1', 'Alpha', 'aaa')];
    const alpha = nodes.find((n) => n.id === 'n1')!;
    const { skills, plain } = expandSkillHits(nodes, [nodes[0], alpha]);
    expect(plain.map((n) => n.id)).toEqual(['n1']);
    expect(skills.every((n) => n.skill?.tree === TREE)).toBe(true);
  });
});

describe('recallBrain with skills', () => {
  const graph = (extra: BrainNode[] = []) => ({ nodes: [...tree(), ...extra], edges: [] });

  it('renders the tree as one block, never as one bullet per step', () => {
    const r = recallBrain(graph(), 'read the role and company off a linkedin card');
    expect(r.preamble).toContain('### SKILL:');
    // Not a "- [strategy] <step title>" line anywhere.
    expect(r.preamble).not.toMatch(/^- \[strategy\] Scroll the card/m);
  });

  it('does not inject a skill library wholesale through the small-graph bypass', () => {
    // spine.ts's first hazard: recall injects the WHOLE graph at <=40 nodes. A
    // skill library must not ride that, or a handful of trees becomes the
    // entire context.
    const many: BrainNode[] = [];
    for (let i = 0; i < 6; i++) {
      const f = parseSkillFile(CANONICAL.replace(/"li-read-card"/, `"tree-${i}"`));
      many.push(...expandSkillFile(f).nodes);
    }
    const r = recallBrain({ nodes: many, edges: [] }, 'read the role and company off a linkedin card');
    const skillCount = r.nodes.filter((n) => n.skill?.tree).length;
    expect(many.length).toBe(30);
    expect(skillCount).toBeLessThanOrEqual(8); // skillBudget
  });

  it('leaves ordinary nodes on the normal bullet path', () => {
    const r = recallBrain(graph([flat('n1', 'Alpha', 'aaa')]), 'alpha');
    expect(r.preamble).toContain('- [strategy] Alpha: aaa');
  });

  it('does not list a step\'s own parent and siblings as "related"', () => {
    // Intra-tree edges say nothing the indentation didn't already say.
    const nodes = tree();
    const e = expandSkillFile(parseSkillFile(CANONICAL)).edges;
    const r = recallBrain({ nodes, edges: e }, 'read the role and company off a linkedin card');
    expect(r.preamble).not.toContain('↳ related:');
  });

  it('returns a skill even when nothing else matched', () => {
    const filler: BrainNode[] = [];
    for (let i = 0; i < 45; i++) filler.push(flat(`f${i}`, `Filler ${i}`, 'zzz unrelated'));
    const r = recallBrain(
      { nodes: [...tree(), ...filler], edges: [] },
      'subtitle lazily rendered linkedin result card role company',
    );
    expect(r.nodes.some((n) => n.skill?.tree === TREE)).toBe(true);
    expect(r.preamble).toContain('### SKILL:');
  });
});
