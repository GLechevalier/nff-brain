import { describe, expect, it } from 'vitest';
import { buildZoneSpine, isZoneSpineId, zoneLayoutEdges, zoneOf, ZONES } from '../src/zones.js';
import type { LayoutEdge } from '../src/layout.js';

const node = (id: string, over: Partial<Parameters<typeof zoneOf>[0]> = {}) => ({
  id,
  category: 'analysis',
  origin: 'agent',
  ...over,
});

describe('zoneOf', () => {
  it('observed outcomes win over everything', () => {
    expect(zoneOf(node('a', { skill: { outcome: { tried: 3 } }, origin: 'workflow' }))).toBe('conditioning');
  });

  it('an untried skill is procedural, not conditioning', () => {
    expect(zoneOf(node('a', { skill: {} }))).toBe('procedural');
    expect(zoneOf(node('a', { skill: { outcome: { tried: 0 } } }))).toBe('procedural');
  });

  it('workflow/tool origins and strategy playbooks are procedural', () => {
    expect(zoneOf(node('a', { origin: 'workflow' }))).toBe('procedural');
    expect(zoneOf(node('a', { origin: 'tool' }))).toBe('procedural');
    expect(zoneOf(node('a', { category: 'strategy' }))).toBe('procedural');
  });

  it('clips and session imports are episodic', () => {
    expect(zoneOf(node('a', { origin: 'clip' }))).toBe('episodic');
    expect(zoneOf(node('a', { origin: 'import' }))).toBe('episodic');
  });

  it('everything else is semantic', () => {
    for (const origin of ['agent', 'seed', 'graphify', 'supabase']) {
      expect(zoneOf(node('a', { origin }))).toBe('semantic');
    }
  });
});

describe('buildZoneSpine', () => {
  const hub = node('hub', { category: 'core', origin: 'seed' });
  const nodes = [
    hub,
    node('s1', { category: 'strategy' }), // procedural island {s1, s2}
    node('s2', { category: 'strategy' }),
    node('f1'), // semantic island {f1}, connected only through the hub
    node('e1', { origin: 'import' }), // episodic island {e1}
    node('x1'), // exempt island {x1}
  ];
  const edges: LayoutEdge[] = [
    { from: 's1', to: 's2', strength: 1 },
    { from: 'hub', to: 's1', strength: 1 },
    { from: 'hub', to: 'f1', strength: 1 },
    { from: 'hub', to: 'x1', strength: 1 },
  ];

  it('emits all four zone groups with spine-prefixed ids, covering each node once', () => {
    const spine = buildZoneSpine(nodes, edges, { exclude: (n) => n.id === 'x1' });
    expect(spine.rootId).toBe('hub');
    expect(spine.nodes.map((g) => g.id).sort()).toEqual(ZONES.map((z) => `spine:zone-${z}`).sort());
    for (const g of spine.nodes) expect(isZoneSpineId(g.id)).toBe(true);
    const all = spine.nodes.flatMap((g) => g.memberIds);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(['e1', 'f1', 's1', 's2']); // no hub, no exempt x1
  });

  it('votes per island and splits hub-adjacent clusters via interior edges', () => {
    const spine = buildZoneSpine(nodes, edges, { exclude: (n) => n.id === 'x1' });
    const byZone = Object.fromEntries(spine.nodes.map((g) => [g.id, g.memberIds.sort()]));
    expect(byZone['spine:zone-procedural']).toEqual(['s1', 's2']);
    expect(byZone['spine:zone-semantic']).toEqual(['f1']);
    expect(byZone['spine:zone-episodic']).toEqual(['e1']);
    expect(byZone['spine:zone-conditioning']).toEqual([]);
  });

  it('hangs all-exempt islands off the root, not a zone', () => {
    const spine = buildZoneSpine(nodes, edges, { exclude: (n) => n.id === 'x1' });
    expect(spine.edges).toContainEqual({ from: 'hub', to: 'x1', strength: 0.3 });
  });

  it('zoneLayoutEdges drops only root-incident edges', () => {
    expect(zoneLayoutEdges(edges, 'hub')).toEqual([{ from: 's1', to: 's2', strength: 1 }]);
  });
});
