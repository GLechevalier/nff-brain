// Always-on tripwire: real-account credentials must NEVER be tracked by git.
// Cheap insurance on a dev box where files get copied around — if git ever
// picks up .auth/ or .env.evals (or a stray profile/artifact), CI goes red.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const evalsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(evalsRoot, '..', '..');

const FORBIDDEN = [/\.auth\//, /\.env\.evals$/, /\.profiles\//, /state\//, /artifacts\//];

describe('evals secrets guard', () => {
  it('git tracks no credentials, profiles or run state under packages/evals', () => {
    let tracked: string;
    try {
      tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', 'packages/evals'], { encoding: 'utf8' });
    } catch {
      return; // not a git checkout (tarball CI) — nothing to leak
    }
    const offenders = tracked
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(offenders, `tracked secret-adjacent files: ${offenders.join(', ')}`).toEqual([]);
  });
});
