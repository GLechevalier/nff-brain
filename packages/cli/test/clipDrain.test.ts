// Unit coverage for the three pagevisit-related changes to the server-side
// drain: explicit-clips-first batch priority, per-origin pruning, and
// isClipTierNode-based known-node visibility for the model. `runClaude` is
// mocked (real fs, real applyClips/pruneClips/buildClipPrompt) so this stays
// fast and deterministic — no CLI build, no child process, unlike
// e2eClips.test.ts's full end-to-end coverage of the happy path.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runClaude } = vi.hoisted(() => ({
  runClaude: vi.fn(async (_prompt: string, _opts?: unknown): Promise<string> => '{}'),
}));
vi.mock('@nff-brain/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nff-brain/core')>();
  return { ...actual, runClaude };
});

import { MAX_CLIP_NODES, MAX_PAGEVISIT_NODES } from '@nff-brain/core';
import { drainClips, MAX_CLIPS_PER_DRAIN } from '../src/clipDrain.js';

let dir: string;
let globalBrain: string;

function writeBrain(file: string, nodes: Array<{ id: string; origin: string; recallCount?: number }>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        id: n.id,
        title: n.id,
        category: 'strategy',
        content: `content ${n.id}`,
        color: '#a78bfa',
        x: 0,
        y: 0,
        size: 16,
        origin: n.origin,
        lastUpdated: new Date().toISOString(),
        recallCount: n.recallCount ?? 0,
      })),
      edges: [],
    }),
  );
}

function readBrain(file: string): { nodes: Array<{ id: string; origin: string }> } {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clipLine(id: string, kind: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      v: 1,
      id,
      at: new Date().toISOString(),
      kind,
      text: `text of ${id}`,
      target: 'global',
      source: 'chrome',
      ...extra,
    }) + '\n'
  );
}

function clipsFile(): string {
  return path.join(path.dirname(globalBrain), 'clips.jsonl');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-clipdrain-'));
  globalBrain = path.join(dir, '.nff-brain', 'brain.json');
  runClaude.mockReset().mockResolvedValue('{}');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const paths = () => ({ workspaceRoot: dir, project: globalBrain, global: globalBrain });

describe('drainClips — pagevisit priority and pruning', () => {
  it('gives explicit clips first claim on the batch cap, page visits fill the remainder', async () => {
    fs.mkdirSync(path.dirname(globalBrain), { recursive: true });
    // 30 pagevisit clips queued FIRST (chronologically earlier), then 5
    // explicit clips queued LAST — despite arriving later, explicit clips
    // must still win the batch.
    const visitLines = Array.from({ length: 30 }, (_, i) => clipLine(`v${i}`, 'pagevisit')).join('');
    const explicitLines = Array.from({ length: 5 }, (_, i) => clipLine(`e${i}`, 'selection')).join('');
    fs.writeFileSync(clipsFile(), visitLines + explicitLines);

    let capturedPrompt = '';
    runClaude.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return '{}';
    });

    await drainClips(paths());

    // All 5 explicit clips present; only the batch's remaining 20 slots of
    // page visits (v0..v19, chronological) — v20..v29 excluded from THIS batch.
    for (let i = 0; i < 5; i++) expect(capturedPrompt).toContain(`text of e${i}`);
    for (let i = 0; i < 20; i++) expect(capturedPrompt).toContain(`text of v${i}`);
    for (let i = 20; i < 30; i++) expect(capturedPrompt).not.toContain(`text of v${i}`);
    expect(MAX_CLIPS_PER_DRAIN).toBe(25); // the assumption this test is built on
  });

  it('prunes each origin tier separately, against its own cap', async () => {
    const nodes: Array<{ id: string; origin: string; recallCount: number }> = [];
    for (let i = 0; i < MAX_CLIP_NODES + 5; i++) nodes.push({ id: `clip-${i}`, origin: 'clip', recallCount: i });
    for (let i = 0; i < MAX_PAGEVISIT_NODES + 2; i++) nodes.push({ id: `visit-${i}`, origin: 'pagevisit', recallCount: i });
    writeBrain(globalBrain, nodes);
    // One clip just to get past the drain's empty-queue early return.
    fs.writeFileSync(clipsFile(), clipLine('clp_trigger', 'selection'));

    await drainClips(paths());

    const brain = readBrain(globalBrain);
    const clipNodes = brain.nodes.filter((n) => n.origin === 'clip');
    const visitNodes = brain.nodes.filter((n) => n.origin === 'pagevisit');
    expect(clipNodes.length).toBeLessThanOrEqual(MAX_CLIP_NODES);
    expect(visitNodes.length).toBeLessThanOrEqual(MAX_PAGEVISIT_NODES);
    // Coldest (lowest recallCount) go first, in EACH tier independently.
    expect(brain.nodes.some((n) => n.id === 'clip-0')).toBe(false);
    expect(brain.nodes.some((n) => n.id === 'visit-0')).toBe(false);
  });

  it('shows the model existing pagevisit nodes too, so a re-visit can be flagged as a duplicate', async () => {
    writeBrain(globalBrain, [{ id: 'known-visit', origin: 'pagevisit' }]);
    fs.writeFileSync(clipsFile(), clipLine('clp_new', 'pagevisit', { url: 'https://example.com/x' }));

    let capturedPrompt = '';
    runClaude.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return '{}';
    });

    await drainClips(paths());

    expect(capturedPrompt).toContain('id="known-visit"');
  });
});
