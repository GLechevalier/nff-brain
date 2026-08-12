import { describe, expect, it } from 'vitest';
import { shouldRunWizard } from '../src/commands/importPlan.js';
import { parseArgs } from '../src/util.js';

const open = (argv: string[] = [], env: NodeJS.ProcessEnv = {}, tty = { in: true, out: true, err: true }) =>
  shouldRunWizard({ args: parseArgs(argv), stdinTTY: tty.in, stdoutTTY: tty.out, stderrTTY: tty.err, env });

describe('shouldRunWizard', () => {
  it('opens for a bare invocation in a clean TTY', () => {
    expect(open()).toBe(true);
  });

  // Allowlist-free: EVERY flag closes the gate, including ones added later.
  it.each([
    'all', 'limit', 'since', 'yes', 'apply', 'project', 'force', 'global', 'model',
    'concurrency', 'min-confidence', 'max-new', 'stdin-hook', 'no-interactive', 'some-future-flag',
  ])('--%s closes the gate', (flag) => {
    expect(open([`--${flag}`])).toBe(false);
  });

  it('a value flag mis-parsed as boolean still closes the gate (VALUE_FLAGS trap)', () => {
    // If `--since` ever fell out of VALUE_FLAGS, `--since 7d` would parse as
    // {since:true} + positional "7d" — both of which close the gate.
    expect(open(['--since', '7d'])).toBe(false);
  });

  it('a positional closes the gate', () => {
    expect(open(['something'])).toBe(false);
  });

  it('any non-TTY stream closes the gate', () => {
    expect(open([], {}, { in: false, out: true, err: true })).toBe(false);
    expect(open([], {}, { in: true, out: false, err: true })).toBe(false);
    // 2>/dev/null would eat the chrome invisibly — stderr must be a TTY too.
    expect(open([], {}, { in: true, out: true, err: false })).toBe(false);
  });

  it.each([
    ['NFF_BRAIN_SKIP', '1'], // spawned by our own claude -p
    ['CI', '1'],
    ['TERM', 'dumb'],
    ['NFF_BRAIN_NO_TTY', '1'],
  ])('env %s=%s closes the gate', (k, v) => {
    expect(open([], { [k]: v })).toBe(false);
  });
});
