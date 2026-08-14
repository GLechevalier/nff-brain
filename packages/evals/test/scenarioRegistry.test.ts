// Tier-0 shape pins for the scenario registry — CI-cheap, no SDKs, no browser.

import { describe, expect, it } from 'vitest';
import { isValidScenarioId, missingCapabilities } from '../src/scenario.js';
import { SCENARIOS } from '../src/scenarios/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('scenario registry', () => {
  it('ids are unique and well-formed (<category>.<name>.L<level>)', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isValidScenarioId(id), id).toBe(true);
  });

  it('every id embeds its own category and level', () => {
    for (const s of SCENARIOS) {
      expect(s.id.startsWith(`${s.category}.`), s.id).toBe(true);
      expect(s.id.endsWith(`.L${s.level}`), s.id).toBe(true);
    }
  });

  it('reps/passRate/maxActions are sane', () => {
    for (const s of SCENARIOS) {
      expect(s.reps, s.id).toBeGreaterThanOrEqual(1);
      expect(s.passRate, s.id).toBeGreaterThan(0);
      expect(s.passRate, s.id).toBeLessThanOrEqual(1);
      expect(s.maxActions, s.id).toBeGreaterThanOrEqual(0);
      expect(s.maxActions, s.id).toBeLessThanOrEqual(25); // server ceiling
      expect(s.requires.length, `${s.id} must declare its capability gates`).toBeGreaterThan(0);
    }
  });

  it('LinkedIn destructive scenarios are budgeted and human-reviewed', () => {
    for (const s of SCENARIOS) {
      if (s.sites.includes('linkedin') && s.maxActions > 0) {
        expect(s.budget?.site, `${s.id} needs a linkedin budget`).toBe('linkedin');
        expect(s.maxActions, `${s.id} destructive cap`).toBeLessThanOrEqual(3);
        expect(s.humanReview, `${s.id} needs humanReview`).toBe(true);
      }
    }
  });

  it('capabilities.json lists only known tags, and baseline scenarios are live', () => {
    const caps = JSON.parse(fs.readFileSync(path.join(evalsRoot, 'capabilities.json'), 'utf8')) as { live: string[] };
    // ACT-* tags belong to the act benchmark (src/act/actScenario.ts), which
    // shares this capabilities.json — deliberate same-commit widening.
    const known = /^(baseline|P0-harness|P1-engine|P2-loop|P3-adapter:[a-z]+|P4-confirm|P4-downloads|P5-crosssite|ACT-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
    for (const tag of caps.live) expect(tag).toMatch(known);
    // The P0 exit-criterion scenario must be runnable the moment the harness exists.
    const smoke = SCENARIOS.find((s) => s.id === 'linkedin.connect.L1');
    expect(smoke).toBeDefined();
    expect(missingCapabilities(smoke!, caps)).toEqual([]);
  });
});
