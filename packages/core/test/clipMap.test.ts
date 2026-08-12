import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CLIP_MAP_BYTES,
  appendClipMap,
  clipMapPath,
  compactClipMap,
  readClipMap,
  seenClipIds,
} from '../src/index.js';

let dir: string;
let brainPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-clipmap-'));
  brainPath = path.join(dir, '.nff-brain', 'brain.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('clip-map ledger', () => {
  it('appends and reads entries, filtered by clientId and since', () => {
    appendClipMap(
      brainPath,
      [
        { clipId: 'clp_1', clientId: 'cl_a', nodeIds: ['n1'] },
        { clipId: 'clp_2', clientId: 'cl_b', nodeIds: [] },
      ],
      new Date('2026-08-01T00:00:00Z'),
    );
    appendClipMap(brainPath, [{ clipId: 'clp_3', clientId: 'cl_a', nodeIds: ['n2', 'n3'] }], new Date('2026-08-10T00:00:00Z'));

    expect(readClipMap(brainPath)).toHaveLength(3);
    expect(readClipMap(brainPath, { clientId: 'cl_a' }).map((e) => e.clipId)).toEqual(['clp_1', 'clp_3']);
    expect(readClipMap(brainPath, { since: '2026-08-05T00:00:00Z' }).map((e) => e.clipId)).toEqual(['clp_3']);
  });

  it('seenClipIds includes worthless (nodeIds: []) clips — that IS the dedupe', () => {
    appendClipMap(brainPath, [
      { clipId: 'clp_1', nodeIds: ['n1'] },
      { clipId: 'clp_2', nodeIds: [] },
    ]);
    const seen = seenClipIds(brainPath);
    expect(seen.has('clp_1')).toBe(true);
    expect(seen.has('clp_2')).toBe(true);
  });

  it('tolerates a torn tail without losing whole lines', () => {
    appendClipMap(brainPath, [{ clipId: 'clp_1', nodeIds: ['n1'] }]);
    fs.appendFileSync(clipMapPath(brainPath), '{"v":1,"clipId":"torn'); // no newline, no close
    expect(readClipMap(brainPath).map((e) => e.clipId)).toEqual(['clp_1']);
  });

  it('compaction strips dead node ids and keeps entries otherwise', () => {
    appendClipMap(brainPath, [
      { clipId: 'clp_1', nodeIds: ['gone', 'kept'] },
      { clipId: 'clp_2', nodeIds: ['gone'] },
    ]);
    compactClipMap(brainPath, { dropNodeIds: new Set(['gone']) });
    const entries = readClipMap(brainPath);
    expect(entries.find((e) => e.clipId === 'clp_1')!.nodeIds).toEqual(['kept']);
    // Still ledgered (dedupe intact) even though its only node is gone.
    expect(entries.find((e) => e.clipId === 'clp_2')!.nodeIds).toEqual([]);
  });

  it('compaction keeps the NEWEST lines when over the byte cap', () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({
      clipId: `clp_${i}`,
      nodeIds: [`node-${'x'.repeat(80)}-${i}`],
    }));
    appendClipMap(brainPath, big);
    expect(fs.statSync(clipMapPath(brainPath)).size).toBeGreaterThan(MAX_CLIP_MAP_BYTES);
    compactClipMap(brainPath);
    expect(fs.statSync(clipMapPath(brainPath)).size).toBeLessThanOrEqual(MAX_CLIP_MAP_BYTES);
    const entries = readClipMap(brainPath);
    expect(entries[entries.length - 1].clipId).toBe('clp_2999'); // newest survived
  });

  it('reading a missing file is an empty ledger, not an error', () => {
    expect(readClipMap(brainPath)).toEqual([]);
    expect(seenClipIds(brainPath).size).toBe(0);
    compactClipMap(brainPath); // no-op, no throw
  });
});
