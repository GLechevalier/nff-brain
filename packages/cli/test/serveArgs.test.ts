import { describe, expect, it } from 'vitest';
import { flagNum, flagStr, parseArgs } from '../src/util.js';

// VALUE_FLAGS is a GLOBAL set shared by every command, and a flag missing from
// it parses as a boolean plus a stray positional — a silent no-op rather than an
// error. These are the tripwires for the flags `serve` and `pair` added.

describe('serve/pair value flags', () => {
  it.each(['port', 'target', 'allow-origin', 'revoke', 'name'])('--%s takes a value', (flag) => {
    const args = parseArgs([`--${flag}`, 'VALUE']);
    expect(flagStr(args, flag)).toBe('VALUE');
    expect(args.positional).toEqual([]);
  });

  it.each(['quiet', 'list', 'reset'])('--%s stays boolean', (flag) => {
    const args = parseArgs([`--${flag}`]);
    expect(args.flags[flag]).toBe(true);
  });

  it('still supports --key=value', () => {
    expect(flagStr(parseArgs(['--target=project']), 'target')).toBe('project');
  });

  it('parses --port 0 to the number 0', () => {
    // THE FALSY GUARD. `flagNum(args,'port') || DEFAULT` would silently turn an
    // explicit request for an OS-assigned port into 7373; serve.ts uses ?? for
    // exactly this reason, and --port 0 is what the e2e suite relies on.
    const args = parseArgs(['--port', '0']);
    expect(flagStr(args, 'port')).toBe('0');
    expect(flagNum(args, 'port')).toBe(0);
    expect(flagNum(args, 'port') ?? 7373).toBe(0);
  });

  it('leaves port undefined when the flag is absent', () => {
    expect(flagNum(parseArgs([]), 'port')).toBeUndefined();
  });

  it('does not swallow the next flag as a value', () => {
    const args = parseArgs(['--port', '--quiet']);
    expect(args.flags.port).toBe(true);
    expect(args.flags.quiet).toBe(true);
  });
});
