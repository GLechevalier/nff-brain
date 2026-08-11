import { describe, expect, it } from 'vitest';
import { dot } from '../src/vector.js';
import { embedModel, embedQuery, embedTexts, resetEmbedder } from '../src/embed.js';
import { DEFAULT_SEMANTIC_FLOOR } from '../src/rank.js';

// OPT-IN ONLY — never runs in CI. The 6-combo matrix {ubuntu, windows} × node
// {18,20,22} must not download a ~400 MB native runtime or a model.
//
//   nff-brain semantic install
//   NFF_BRAIN_TEST_SEMANTIC=1 npx vitest run packages/core/test/embed.integration.test.ts
//
// This is the only test that exercises the REAL model. It exists to catch the
// two things unit tests structurally cannot: that the package resolves to its
// NODE build (the web build fails with "Failed to parse URL from /models/..."),
// and that the cosine distribution still separates matches from noise — which
// is what DEFAULT_SEMANTIC_FLOOR is calibrated against.

const enabled = process.env.NFF_BRAIN_TEST_SEMANTIC === '1';

const DNS = 'Fleet DNS wedge\n\nContainers going offline need force-recreate, not docker restart.';
const PS = 'PowerShell quoting rules\n\nUse here-strings for multiline args; backtick escapes break.';

describe.skipIf(!enabled)('embed (real model)', () => {
  it('loads and returns a unit vector of the expected width', async () => {
    resetEmbedder();
    const v = await embedQuery('does the model load at all');
    expect(v, 'model failed to load — run `nff-brain semantic install`').not.toBeNull();
    expect(v!.length).toBeGreaterThanOrEqual(128);
    expect(dot(v!, v!)).toBeCloseTo(1, 4); // normalised at the source
  }, 120_000);

  it('ranks a paraphrase above an unrelated node', async () => {
    const [dns, ps] = (await embedTexts([DNS, PS]))!;
    const q = (await embedQuery('my containers keep dropping off the network'))!;
    const simDns = dot(q, dns!);
    const simPs = dot(q, ps!);
    expect(simDns).toBeGreaterThan(simPs);
    expect(simDns).toBeGreaterThan(DEFAULT_SEMANTIC_FLOOR);
  }, 120_000);

  it('keeps an unrelated query below the floor (the false-positive guard)', async () => {
    const [dns, ps] = (await embedTexts([DNS, PS]))!;
    const q = (await embedQuery('how do I bake sourdough bread'))!;
    // If this ever fails, the floor is too low for the current model and
    // unrelated nodes will start appearing in results.
    expect(Math.max(dot(q, dns!), dot(q, ps!))).toBeLessThan(DEFAULT_SEMANTIC_FLOOR);
  }, 120_000);

  it('applies the retrieval prefix to queries but not to passages', async () => {
    // bge is asymmetric. Encoding the same text as a query and as a passage
    // must NOT produce the identical vector, or the prefix was dropped.
    const model = embedModel();
    if (!model.includes('bge')) return; // symmetric model — nothing to assert
    const asQuery = (await embedQuery('fleet dns wedge'))!;
    const [asPassage] = (await embedTexts(['fleet dns wedge']))!;
    expect(dot(asQuery, asPassage!)).toBeLessThan(0.9999);
  }, 120_000);
});
