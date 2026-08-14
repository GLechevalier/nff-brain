// Tier-0 shape pins for the act-benchmark registries — CI-cheap, no browser.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidScenarioId } from '../src/scenario.js';
import { isAgentScenario, missingActCapabilities } from '../src/act/actScenario.js';
import { ACT_AGENT_SCENARIOS, ACT_CASES } from '../src/act/index.js';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = [...ACT_CASES, ...ACT_AGENT_SCENARIOS];
const TAG = /^ACT-[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('act registry', () => {
  it('has a real taxonomy on both layers', () => {
    expect(ACT_CASES.length).toBeGreaterThanOrEqual(40);
    expect(ACT_AGENT_SCENARIOS.length).toBeGreaterThanOrEqual(15);
  });

  it('ids are unique, well-formed, and in the primitives category', () => {
    const ids = ALL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isValidScenarioId(id), id).toBe(true);
      expect(id.startsWith('primitives.'), id).toBe(true);
    }
  });

  it('layer A ids end .L1 and layer B ids end .L2', () => {
    for (const c of ACT_CASES) expect(c.id.endsWith('.L1'), c.id).toBe(true);
    for (const s of ACT_AGENT_SCENARIOS) expect(s.id.endsWith('.L2'), s.id).toBe(true);
  });

  it('every case declares ACT-* capability gates', () => {
    for (const c of ALL) {
      expect(c.requires.length, `${c.id} must declare gates`).toBeGreaterThan(0);
      for (const tag of c.requires) expect(tag, `${c.id}: ${tag}`).toMatch(TAG);
    }
  });

  it('out-of-scope cases never carry a run()/knownGap, and explain themselves', () => {
    for (const c of ACT_CASES) {
      if (c.outOfScope) {
        expect(c.run, `${c.id} is out-of-scope but has run()`).toBeUndefined();
        expect(c.knownGap, `${c.id} mixes outOfScope and knownGap`).toBeUndefined();
        expect(c.outOfScope.length, c.id).toBeGreaterThan(20);
      }
    }
  });

  it('every LIVE, in-scope conformance case has a run()', () => {
    const caps = JSON.parse(fs.readFileSync(path.join(evalsRoot, 'capabilities.json'), 'utf8')) as { live: string[] };
    for (const c of ACT_CASES) {
      if (!c.outOfScope && missingActCapabilities(c, caps).length === 0) {
        expect(c.run, `${c.id} is live but has no run()`).toBeTypeOf('function');
      }
    }
  });

  it('knownGap cases are runnable (they document engine behavior, not wishes)', () => {
    for (const c of ACT_CASES) {
      if (c.knownGap) {
        expect(c.run, c.id).toBeTypeOf('function');
        expect(missingActCapabilities(c, { live: ['ACT-harness', 'ACT-engine'] }), `${c.id} knownGap must be live under the base tags`).toEqual([]);
      }
    }
  });

  it('agent scenarios stay inside the act ceilings and rep sanity', () => {
    for (const s of ACT_AGENT_SCENARIOS) {
      expect(s.maxActions, s.id).toBeGreaterThan(0);
      expect(s.maxActions, s.id).toBeLessThanOrEqual(100); // ACT_MAX_ACTIONS_CEILING
      expect(s.reps, s.id).toBeGreaterThanOrEqual(2);
      expect(s.passRate, s.id).toBeGreaterThan(0);
      expect(s.passRate, s.id).toBeLessThanOrEqual(1);
      expect(isAgentScenario(s)).toBe(true);
      expect(s.goal.length, s.id).toBeGreaterThan(10);
    }
  });

  it('every referenced fixture page exists', () => {
    for (const c of ALL) {
      const file = path.join(evalsRoot, 'fixtures', c.page);
      expect(fs.existsSync(file), `${c.id} references missing fixture ${c.page}`).toBe(true);
    }
  });

  it('the smoke case is live (the ACT-harness exit criterion)', () => {
    const caps = JSON.parse(fs.readFileSync(path.join(evalsRoot, 'capabilities.json'), 'utf8')) as { live: string[] };
    const smoke = ACT_CASES.find((c) => c.id === 'primitives.pointer-click-left.L1');
    expect(smoke).toBeDefined();
    expect(missingActCapabilities(smoke!, caps)).toEqual([]);
  });
});
