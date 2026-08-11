import { describe, expect, it } from 'vitest';
import { CATEGORIES, parseNodeMd, serializeNodeMd } from '../src/index.js';
import type { BrainNode } from '../src/index.js';

function node(id: string, extra: Partial<BrainNode> = {}): BrainNode {
  return {
    id,
    title: 'Docker restart procedure',
    category: 'rules',
    content: 'When containers wedge, force-recreate them.\n\nSecond paragraph.',
    color: '#4ade80',
    x: 0,
    y: 0,
    size: 16,
    origin: 'agent',
    lastUpdated: '2026-08-10T12:00:00.000Z',
    recallCount: 3,
    ...extra,
  };
}

describe('nodeMd', () => {
  it('round-trips title, category, content and links', () => {
    const md = serializeNodeMd(node('docker-fix'), [
      { id: 'compose-gotcha', strength: 0.8, title: 'Compose gotcha' },
      { id: 'hub', strength: 0.4 },
    ]);
    const parsed = parseNodeMd(md);
    expect(parsed.title).toBe('Docker restart procedure');
    expect(parsed.category).toBe('rules');
    expect(parsed.content).toBe('When containers wedge, force-recreate them.\n\nSecond paragraph.');
    expect(parsed.links).toEqual([
      { id: 'compose-gotcha', strength: 0.8 },
      { id: 'hub', strength: 0.4 },
    ]);
  });

  it('lets the user edit category in the meta line and strengths in links', () => {
    const md = serializeNodeMd(node('x'), [{ id: 'a', strength: 0.6 }])
      .replace('category: rules', 'category: strategy')
      .replace('— 0.60', '— 0.95');
    const parsed = parseNodeMd(md);
    expect(parsed.category).toBe('strategy');
    expect(parsed.links[0].strength).toBe(0.95);
  });

  it('tolerates removed meta/links sections and clamps strengths', () => {
    const parsed = parseNodeMd('# Just a title\n\nBody only.\n\n## Links\n\n- [[far]] — 7.5\n- garbage line\n- [[far]] — 0.2\n');
    expect(parsed.title).toBe('Just a title');
    expect(parsed.category).toBe('strategy'); // default when meta removed
    expect(parsed.content).toBe('Body only.');
    expect(parsed.links).toEqual([{ id: 'far', strength: 1 }]); // clamped, deduped
  });

  // Regression: the meta-line category regex used to be a hardcoded
  // (core|analysis|rules|strategy) alternation, so a node in any newer category
  // failed to match on re-parse and silently fell back to 'strategy' — meaning a
  // no-op save in the VS Code editor rewrote the node's category.
  it.each(CATEGORIES)('round-trips the %s category unchanged', (category) => {
    const md = serializeNodeMd(node('x', { category }), []);
    expect(parseNodeMd(md).category).toBe(category);
  });

  it('does not read the category hint line as the category', () => {
    // The hint lives in the same blockquote as the real meta line; if the user
    // deletes the meta line, we must fall back to the default, not to whatever
    // category happens to be listed first in the hint.
    const md = serializeNodeMd(node('x', { category: 'decision' }), []);
    const withoutMeta = md
      .split('\n')
      .filter((l) => !l.startsWith('> category:'))
      .join('\n');
    expect(withoutMeta).toContain('one of:'); // the hint survived
    expect(parseNodeMd(withoutMeta).category).toBe('strategy');
  });

  it('parses empty links placeholder as no links', () => {
    const md = serializeNodeMd(node('x'), []);
    expect(parseNodeMd(md).links).toEqual([]);
  });

  it('ignores prose before the first heading', () => {
    const parsed = parseNodeMd('stray line\n# Real title\n\nBody.\n');
    expect(parsed.title).toBe('Real title');
    expect(parsed.content).toBe('Body.');
  });
});
