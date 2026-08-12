import { describe, expect, it } from 'vitest';
import { buildClipPrompt, parseClipResponse } from '../src/index.js';
import type { ClipRecord } from '../src/index.js';

function clip(id: string, extra: Partial<ClipRecord> = {}): ClipRecord {
  return {
    v: 1,
    id,
    at: '2026-08-11T00:00:00.000Z',
    kind: 'selection',
    text: `text of ${id}`,
    target: 'global',
    source: 'chrome',
    ...extra,
  };
}

describe('buildClipPrompt', () => {
  it('opens with the registered marker and lists clips by index, never by id', () => {
    const p = buildClipPrompt({
      clips: [
        clip('clp_1_aaaaaa', { url: 'https://docs.example.com/x', title: 'Docs', text: 'first snippet' }),
        clip('clp_2_bbbbbb', { kind: 'link', url: 'https://example.com/post', text: 'second snippet' }),
      ],
      knownClipNodes: [{ id: 'known-clip', title: 'Known clip', sourceUrl: 'https://old.example.com' }],
    });
    expect(p.startsWith('You are the memory clipper')).toBe(true);
    expect(p).toContain('#0 [selection] https://docs.example.com/x "Docs"');
    expect(p).toContain('#1 [link]');
    expect(p).toContain('id="known-clip"');
    // Queue ids never reach the model — indices are the addressing scheme.
    expect(p).not.toContain('clp_1_aaaaaa');
    // No 'core' array: a clip can never become a hub node.
    expect(p).not.toMatch(/"core":\[/);
  });
});

describe('parseClipResponse', () => {
  const clips = [clip('clp_1_a'), clip('clp_2_b'), clip('clp_3_c')];

  it('routes category from the array name and translates indices to clip ids', () => {
    const parsed = parseClipResponse(
      `Here you go:\n{"strategy":[{"i":0,"title":"T","content":"C"}],` +
        `"rules":[{"i":[1,2],"title":"Folded","content":"Both"}],` +
        `"duplicate":[]}`,
      clips,
    )!;
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0]).toMatchObject({ category: 'strategy', clipIds: ['clp_1_a'] });
    // An i-array folds several clips into ONE proposal.
    expect(parsed.proposals[1]).toMatchObject({ category: 'rules', clipIds: ['clp_2_b', 'clp_3_c'] });
  });

  it('drops entries with bad indices or missing text, never the batch', () => {
    const parsed = parseClipResponse(
      `{"strategy":[{"i":99,"title":"T","content":"C"},{"i":0,"title":"","content":"C"},` +
        `{"i":0,"title":"Good","content":"Kept"}],"analysis":"not an array"}`,
      clips,
    )!;
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0].title).toBe('Good');
  });

  it('parses duplicates into clipId → existing-node pairs', () => {
    const parsed = parseClipResponse(`{"duplicate":[{"i":1,"of":"existing-clip-node"}]}`, clips)!;
    expect(parsed.duplicates).toEqual([{ clipId: 'clp_2_b', of: 'existing-clip-node' }]);
  });

  it('clamps title and content to the caps', () => {
    const parsed = parseClipResponse(
      JSON.stringify({ task: [{ i: 0, title: 'x'.repeat(200), content: 'y'.repeat(2000) }] }),
      clips,
    )!;
    expect(parsed.proposals[0].title).toHaveLength(80);
    expect(parsed.proposals[0].content).toHaveLength(600);
  });

  it('returns null (not empty) when nothing parses — the drain must retry, not ledger', () => {
    expect(parseClipResponse('total garbage', clips)).toBeNull();
    expect(parseClipResponse('', clips)).toBeNull();
  });

  it('an empty but valid object parses to zero proposals — the drain may ledger', () => {
    const parsed = parseClipResponse('{}', clips);
    expect(parsed).not.toBeNull();
    expect(parsed!.proposals).toHaveLength(0);
  });
});
