import { describe, expect, it } from 'vitest';
import { emptyBrain, placeNode } from '@nff-brain/core/types';
import type { BrainFile, BrainNode } from '@nff-brain/core/types';
import { applyRemap, buildImportPayload } from '../src/migrate.js';
import type { ActivityRecord } from '../src/schema.js';

// Pure halves of the migration: payload assembly and remap application. The
// network/probe wiring is covered by importRoutes.test.ts (server side) and
// the README's manual migration checklist (live browser).

function node(id: string): BrainNode {
  return {
    id,
    title: id,
    category: 'strategy',
    content: `content of ${id}`,
    ...placeNode('strategy'),
    origin: 'clip',
    sourceUrl: 'https://example.com/x',
    lastUpdated: new Date().toISOString(),
    recallCount: 2,
  };
}

function activity(id: string, clipId: string | undefined, nodeIds: string[]): ActivityRecord {
  return {
    id,
    at: new Date().toISOString(),
    host: 'example.com',
    url: 'https://example.com/x',
    title: 't',
    text: 'x',
    delivery: 'delivered',
    ...(clipId ? { clipId } : {}),
    nodeIds,
  };
}

function fixture(): BrainFile {
  const brain = emptyBrain();
  brain.nodes.push(node('alpha'), node('beta'));
  brain.edges.push({ from: 'alpha', to: 'beta', strength: 0.5 });
  return brain;
}

describe('buildImportPayload', () => {
  it('carries nodes with geometry + provenance, edges, and only clip-map rows that reference local nodes', () => {
    const payload = buildImportPayload(fixture(), [
      activity('a1', 'clp_1', ['alpha']),
      activity('a2', 'clp_2', ['not-a-local-node']),
      activity('a3', undefined, ['beta']), // no clipId → cannot be a map row
    ]);

    expect(payload.nodes.map((n) => n.id)).toEqual(['alpha', 'beta']);
    const alpha = payload.nodes[0]!;
    expect(alpha.category).toBe('strategy');
    expect(alpha.sourceUrl).toBe('https://example.com/x');
    expect(typeof alpha.x).toBe('number');
    expect(alpha.recallCount).toBe(2);
    expect(payload.edges).toEqual([{ from: 'alpha', to: 'beta', strength: 0.5 }]);
    expect(payload.map).toEqual([{ clipId: 'clp_1', nodeIds: ['alpha'] }]);
  });

  it('is stable across rebuilds — same brain, same payload (idempotent retry body)', () => {
    const brain = fixture();
    const acts = [activity('a1', 'clp_1', ['alpha'])];
    expect(buildImportPayload(brain, acts)).toEqual(buildImportPayload(brain, acts));
  });
});

describe('applyRemap', () => {
  it('rewrites remapped node ids in place and reports change', () => {
    const { records, changed } = applyRemap(
      [activity('a1', 'clp_1', ['alpha', 'beta']), activity('a2', 'clp_2', ['gamma'])],
      [{ from: 'alpha', to: 'alpha-2' }],
    );
    expect(changed).toBe(true);
    expect(records[0]!.nodeIds).toEqual(['alpha-2', 'beta']);
    expect(records[1]!.nodeIds).toEqual(['gamma']); // untouched record kept by reference semantics
  });

  it('is a no-op without remaps', () => {
    const input = [activity('a1', 'clp_1', ['alpha'])];
    const { records, changed } = applyRemap(input, []);
    expect(changed).toBe(false);
    expect(records).toEqual(input);
  });
});
