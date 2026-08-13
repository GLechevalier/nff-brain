import { describe, expect, it } from 'vitest';
import {
  BRAIN_NODE_FORMAT,
  BRAIN_NODE_VERSION,
  parseSkillFile,
  serializeSkillFile,
  SkillFileError,
  type SkillFile,
} from '../src/skillFile.js';
import { CANONICAL } from './skillFixture.js';

const parsed = () => parseSkillFile(CANONICAL);

describe('parseSkillFile', () => {
  it('reads the canonical fixture', () => {
    const f = parsed();
    expect(f.format).toBe(BRAIN_NODE_FORMAT);
    expect(f.version).toBe(BRAIN_NODE_VERSION);
    expect(f.tree).toBe('li-read-card');
    expect(f.tags).toEqual(['linkedin', 'people-search', 'card']);
    expect(f.steps).toHaveLength(2);
    expect(f.steps[1].steps).toHaveLength(2);
    expect(f.steps[1].steps![0].kind).toBe('alt');
    expect(f.steps[1].steps![0].onFail).toEqual(['open-profile']);
  });

  it('leaves a plain step without an explicit kind', () => {
    // 'step' is the default; writing it out would make export non-canonical.
    expect(parsed().steps[0].kind).toBeUndefined();
  });

  const rejects = (mutate: (o: Record<string, unknown>) => void, match: RegExp): void => {
    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    mutate(doc);
    expect(() => parseSkillFile(JSON.stringify(doc))).toThrow(match);
  };

  it('rejects a file that is not BRAIN-NODE shaped', () => {
    rejects((o) => (o.format = 'something-else'), /does not look like a BRAIN-NODE/);
  });

  it('rejects a future version rather than guessing', () => {
    rejects((o) => (o.version = 2), /not supported by this build/);
  });

  it('rejects a duplicate key anywhere in the tree, not just among siblings', () => {
    // Global uniqueness is what keeps the derived brain id short; a duplicate
    // would silently make two steps collide on one node.
    rejects((o) => {
      const steps = o.steps as Array<Record<string, unknown>>;
      (steps[1].steps as Array<Record<string, unknown>>)[0].key = 'read-subtitle';
    }, /duplicate step key "read-subtitle"/);
  });

  it('rejects an over-long tree slug', () => {
    rejects((o) => (o.tree = 'x'.repeat(40)), /slugs to 40 chars, max 32/);
  });

  it('rejects an over-long step key', () => {
    rejects((o) => ((o.steps as Array<Record<string, unknown>>)[0].key = 'y'.repeat(25)), /max 20/);
  });

  it('rejects a key with no usable characters', () => {
    rejects((o) => ((o.steps as Array<Record<string, unknown>>)[0].key = '!!!'), /no usable characters/);
  });

  it('rejects an onFail that is not a sibling', () => {
    // A fallback must be an alternative to the SAME sub-problem. Pointing at an
    // unrelated step elsewhere in the tree is a design error, not a jump.
    rejects((o) => {
      const steps = o.steps as Array<Record<string, unknown>>;
      (steps[1].steps as Array<Record<string, unknown>>)[0].onFail = ['read-subtitle'];
    }, /is not a sibling/);
  });

  it('rejects an onFail pointing at itself', () => {
    rejects((o) => {
      const steps = o.steps as Array<Record<string, unknown>>;
      (steps[1].steps as Array<Record<string, unknown>>)[0].onFail = ['scroll-retry'];
    }, /points at itself/);
  });

  it('rejects nesting past the depth cap', () => {
    const deep = (n: number): Record<string, unknown> =>
      n === 0
        ? { key: `k${n}`, title: 'x', content: 'x' }
        : { key: `k${n}`, title: 'x', content: 'x', steps: [deep(n - 1)] };
    rejects((o) => (o.steps = [deep(5)]), /levels deep, max 4/);
  });

  it('rejects an empty steps array', () => {
    rejects((o) => (o.steps = []), /at least one step/);
  });

  it('rejects an unknown kind', () => {
    rejects((o) => ((o.steps as Array<Record<string, unknown>>)[0].kind = 'maybe'), /must be "step" or "alt"/);
  });

  it('names the offending key when a required field is missing', () => {
    rejects((o) => delete (o.steps as Array<Record<string, unknown>>)[0].content, /steps\[0\]\.content is required/);
  });

  it('fails with a descriptive error, not a TypeError, on malformed JSON', () => {
    expect(() => parseSkillFile('{ not json')).toThrow(SkillFileError);
    expect(() => parseSkillFile('{ not json')).toThrow(/not valid JSON/);
  });

  it('rejects a non-object top level', () => {
    expect(() => parseSkillFile('[]')).toThrow(/top level must be a JSON object/);
  });
});

describe('serializeSkillFile', () => {
  it('round-trips the canonical fixture byte for byte', () => {
    expect(serializeSkillFile(parsed())).toBe(CANONICAL);
  });

  it('is idempotent — formatting an already-formatted file changes nothing', () => {
    const once = serializeSkillFile(parsed());
    expect(serializeSkillFile(parseSkillFile(once))).toBe(once);
  });

  it('canonicalizes a differently-ordered file to the same bytes', () => {
    // This is what `skill fmt` is for: authoring order must not affect export.
    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    const scrambled = {
      steps: doc.steps,
      title: doc.title,
      tags: doc.tags,
      version: doc.version,
      content: doc.content,
      verify: doc.verify,
      tree: doc.tree,
      when: doc.when,
      format: doc.format,
    };
    expect(serializeSkillFile(parseSkillFile(JSON.stringify(scrambled)))).toBe(CANONICAL);
  });

  it('omits absent optionals entirely rather than writing null', () => {
    const minimal: SkillFile = {
      format: BRAIN_NODE_FORMAT,
      version: BRAIN_NODE_VERSION,
      tree: 't',
      title: 'T',
      content: 'C',
      steps: [{ key: 'a', title: 'A', content: 'c' }],
    };
    const text = serializeSkillFile(minimal);
    expect(text).not.toContain('null');
    expect(text).not.toContain('"when"');
    expect(text).not.toContain('"kind"');
    expect(parseSkillFile(text)).toEqual(minimal);
  });
});
