// The ship-safety tripwire for the act-benchmark build variant.
//
// build.mjs's NFF_BRAIN_BENCH=1 swaps the sw entry to src/swBench.ts, which
// bundles benchDriver.ts — an unauthenticated loopback command channel that
// must NEVER reach a shipped extension. Three layers keep that true:
// zip.mjs refuses a dist/sw.js containing the sentinel; this test proves the
// PRODUCTION entry cannot pull the driver in through some future import; and
// it proves the BENCH entry really does embed the sentinel (so the zip guard
// has something to catch). Built the way build.mjs builds — bundled, minified
// — same rationale as injectedSource.test.ts: the unminified source proves
// nothing about what ships.

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(url.fileURLToPath(new URL('..', import.meta.url)));

async function bundle(entry: string): Promise<string> {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: 'browser',
    target: 'chrome116',
    format: 'iife',
    conditions: ['nff-brain-source'],
    minify: true,
    write: false,
  });
  return out.outputFiles[0]!.text;
}

describe('bench build variant', () => {
  it('the production sw entry contains no trace of the bench driver', async () => {
    const sw = await bundle('src/sw.ts');
    expect(sw).not.toContain('__NFF_BENCH_DRIVER__');
    expect(sw).not.toContain('/bench/poll');
  }, 60_000);

  it('the bench entry embeds the sentinel the zip guard refuses', async () => {
    const sw = await bundle('src/swBench.ts');
    expect(sw).toContain('__NFF_BENCH_DRIVER__');
    expect(sw).toContain('/bench/poll');
    // And it is a superset of the production worker, not a replacement — the
    // real message handler must still be present.
    expect(sw).toContain('recorderEvent');
  }, 60_000);

  it('zip.mjs contains the sentinel refusal', async () => {
    const { readFileSync } = await import('node:fs');
    const zip = readFileSync(path.join(ROOT, 'zip.mjs'), 'utf8');
    expect(zip).toContain('__NFF_BENCH_DRIVER__');
  });
});
