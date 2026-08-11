import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vectorsPath } from '../src/paths.js';
import { emptyBrain, type BrainFile, type BrainNode } from '../src/types.js';
import { normalise } from '../src/vector.js';
import {
  contentHash,
  decodeVectors,
  indexBrain,
  loadVectors,
  queryVectors,
  vectorPlan,
  type EmbedBatch,
} from '../src/vectorStore.js';

const MODEL = 'test/fake-embedder';
const DIM = 8;

function node(id: string, title: string, content: string): BrainNode {
  return {
    id,
    title,
    category: 'strategy',
    content,
    color: '#fff',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: new Date(0).toISOString(),
    recallCount: 0,
  };
}

function brainOf(...nodes: BrainNode[]): BrainFile {
  return { ...emptyBrain(), nodes };
}

/**
 * Deterministic fake embedder — the OneShot injection convention, applied to
 * embeddings. Same text ⇒ same vector, no model, no network, no mocking
 * framework. `calls` is what proves the reuse path never re-embeds.
 */
function fakeEmbedder(): EmbedBatch & { calls: string[][]; embedded: number } {
  const fn = (async (texts: string[]) => {
    fn.calls.push(texts);
    fn.embedded += texts.length;
    return texts.map((t) => {
      let h = 2166136261;
      const out = new Float32Array(DIM);
      for (let i = 0; i < t.length; i++) {
        h = Math.imul(h ^ t.charCodeAt(i), 16777619);
        out[i % DIM] = out[i % DIM]! + ((h >>> 16) % 1000) / 1000 - 0.5;
      }
      return normalise(out) ?? Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
    });
  }) as EmbedBatch & { calls: string[][]; embedded: number };
  fn.calls = [];
  fn.embedded = 0;
  return fn;
}

/** An embedder that is installed but cannot produce anything (native load fail). */
const brokenEmbedder: EmbedBatch = async (texts) => texts.map(() => null);

let dir: string;
let brainPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-vec-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
  fs.mkdirSync(path.dirname(brainPath), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vectorPlan', () => {
  it('marks everything stale when there is no sidecar', () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    const plan = vectorPlan(brain, null, MODEL);
    expect(plan.stale).toEqual(['a', 'b']);
    expect(plan.fresh).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('marks everything stale when the sidecar used a different model', () => {
    const brain = brainOf(node('a', 'A', 'aaa'));
    const vf = {
      version: 1,
      model: 'other/model',
      dim: DIM,
      updatedAt: '',
      nodes: { a: { h: contentHash('other/model', brain.nodes[0]!), v: '' } },
    };
    expect(vectorPlan(brain, vf, MODEL).stale).toEqual(['a']);
  });
});

describe('indexBrain', () => {
  it('embeds every node on a cold index and writes the sidecar', async () => {
    const embed = fakeEmbedder();
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    const res = await indexBrain(brainPath, brain, embed, { model: MODEL, dim: DIM });

    expect(res.embedded).toBe(2);
    expect(res.reused).toBe(0);
    expect(res.failed).toBe(0);
    expect(fs.existsSync(vectorsPath(brainPath))).toBe(true);

    const vf = loadVectors(brainPath)!;
    expect(vf.model).toBe(MODEL);
    expect(vf.dim).toBe(DIM);
    expect(Object.keys(vf.nodes).sort()).toEqual(['a', 'b']);
    expect(decodeVectors(vf).get('a')).toHaveLength(DIM);
  });

  it('reuses everything on a second run and embeds NOTHING', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });

    const second = fakeEmbedder();
    const res = await indexBrain(brainPath, brain, second, { model: MODEL, dim: DIM });
    expect(second.embedded).toBe(0); // the whole point of the content hash
    expect(res.embedded).toBe(0);
    expect(res.reused).toBe(2);
  });

  it('re-embeds exactly the one node whose content changed', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });

    const edited = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'CHANGED'));
    const embed = fakeEmbedder();
    const res = await indexBrain(brainPath, edited, embed, { model: MODEL, dim: DIM });
    expect(embed.embedded).toBe(1);
    expect(embed.calls[0]![0]).toContain('CHANGED');
    expect(res.embedded).toBe(1);
    expect(res.reused).toBe(1);
  });

  it('re-embeds when only the title changed', async () => {
    const brain = brainOf(node('a', 'Original title', 'body'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });
    const embed = fakeEmbedder();
    await indexBrain(brainPath, brainOf(node('a', 'New title', 'body')), embed, { model: MODEL, dim: DIM });
    expect(embed.embedded).toBe(1);
  });

  it('prunes entries for deleted nodes', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });

    const res = await indexBrain(brainPath, brainOf(node('a', 'A', 'aaa')), fakeEmbedder(), {
      model: MODEL,
      dim: DIM,
    });
    expect(res.pruned).toBe(1);
    expect(Object.keys(loadVectors(brainPath)!.nodes)).toEqual(['a']);
  });

  it('rebuilds everything when the model changes', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });

    const embed = fakeEmbedder();
    await indexBrain(brainPath, brain, embed, { model: 'other/model', dim: DIM });
    expect(embed.embedded).toBe(2);
    expect(loadVectors(brainPath)!.model).toBe('other/model');
  });

  it('re-embeds everything under --force', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });
    const embed = fakeEmbedder();
    await indexBrain(brainPath, brain, embed, { model: MODEL, dim: DIM, force: true });
    expect(embed.embedded).toBe(1);
  });

  it('treats a corrupt sidecar as absent and rebuilds without throwing', async () => {
    fs.writeFileSync(vectorsPath(brainPath), '{ this is not json');
    expect(loadVectors(brainPath)).toBeNull();

    const embed = fakeEmbedder();
    const res = await indexBrain(brainPath, brainOf(node('a', 'A', 'aaa')), embed, { model: MODEL, dim: DIM });
    expect(res.embedded).toBe(1);
    expect(loadVectors(brainPath)).not.toBeNull();
  });

  it('does NOT overwrite a good sidecar when the embedder is broken', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'));
    await indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM });
    const before = fs.readFileSync(vectorsPath(brainPath), 'utf8');

    const edited = brainOf(node('a', 'A', 'CHANGED'));
    const res = await indexBrain(brainPath, edited, brokenEmbedder, { model: MODEL, dim: DIM });
    expect(res.failed).toBe(1);
    expect(res.embedded).toBe(0);
    expect(fs.readFileSync(vectorsPath(brainPath), 'utf8')).toBe(before);
  });

  it('gitignores the sidecar so a derived blob never gets committed', async () => {
    await indexBrain(brainPath, brainOf(node('a', 'A', 'aaa')), fakeEmbedder(), { model: MODEL, dim: DIM });
    const gi = path.join(path.dirname(brainPath), '.gitignore');
    expect(fs.readFileSync(gi, 'utf8')).toContain('vectors.json');

    // Idempotent: a second index must not append a duplicate line.
    await indexBrain(brainPath, brainOf(node('a', 'A', 'aaa')), fakeEmbedder(), { model: MODEL, dim: DIM });
    const lines = fs.readFileSync(gi, 'utf8').split(/\r?\n/).filter((l) => l.trim() === 'vectors.json');
    expect(lines).toHaveLength(1);
  });

  it('survives two concurrent indexes without corrupting the file', async () => {
    const brain = brainOf(node('a', 'A', 'aaa'), node('b', 'B', 'bbb'));
    await Promise.all([
      indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM }),
      indexBrain(brainPath, brain, fakeEmbedder(), { model: MODEL, dim: DIM }),
    ]);
    const vf = loadVectors(brainPath);
    expect(vf).not.toBeNull();
    expect(Object.keys(vf!.nodes).sort()).toEqual(['a', 'b']);
  });

  it('round-trips vectors through the sidecar bit-for-bit', async () => {
    const embed = fakeEmbedder();
    const brain = brainOf(node('a', 'A', 'aaa'));
    await indexBrain(brainPath, brain, embed, { model: MODEL, dim: DIM });
    const stored = decodeVectors(loadVectors(brainPath))!.get('a')!;
    const [fresh] = await embed(['A\n\naaa']);
    expect(Array.from(stored)).toEqual(Array.from(fresh!));
  });
});

describe('queryVectors', () => {
  let globalPath: string;

  beforeEach(() => {
    globalPath = path.join(dir, 'global', 'brain.json');
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  });

  it('lets the project win on an id collision, matching mergeBrains', async () => {
    await indexBrain(brainPath, brainOf(node('shared', 'Project', 'project body')), fakeEmbedder(), {
      model: MODEL,
      dim: DIM,
    });
    await indexBrain(globalPath, brainOf(node('shared', 'Global', 'global body'), node('only-global', 'G', 'g')), fakeEmbedder(), {
      model: MODEL,
      dim: DIM,
    });

    const { vectors } = queryVectors({ project: brainPath, global: globalPath });
    expect([...vectors.keys()].sort()).toEqual(['only-global', 'shared']);

    const projectOnly = decodeVectors(loadVectors(brainPath))!.get('shared')!;
    expect(Array.from(vectors.get('shared')!)).toEqual(Array.from(projectOnly));
  });

  it('ignores a global sidecar built with a different model, and says so', async () => {
    await indexBrain(brainPath, brainOf(node('a', 'A', 'aaa')), fakeEmbedder(), { model: MODEL, dim: DIM });
    await indexBrain(globalPath, brainOf(node('g', 'G', 'ggg')), fakeEmbedder(), {
      model: 'other/model',
      dim: DIM,
    });

    const res = queryVectors({ project: brainPath, global: globalPath });
    expect([...res.vectors.keys()]).toEqual(['a']);
    expect(res.mismatch).toMatch(/global ignored/);
  });

  it('is empty (not an error) when nothing is indexed', () => {
    const res = queryVectors({ project: brainPath, global: globalPath });
    expect(res.vectors.size).toBe(0);
    expect(res.model).toBeNull();
  });
});
