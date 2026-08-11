import { describe, expect, it } from 'vitest';
import { parseSince } from '../src/commands/import.js';
import { parseArgs } from '../src/util.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const days = (n: number) => n * 86_400_000;

describe('parseSince', () => {
  it('reads relative windows', () => {
    expect(parseSince('7d', NOW)).toBe(NOW.getTime() - days(7));
    expect(parseSince('48h', NOW)).toBe(NOW.getTime() - 48 * 3_600_000);
    expect(parseSince('3w', NOW)).toBe(NOW.getTime() - days(21));
    expect(parseSince(' 2d ', NOW)).toBe(NOW.getTime() - days(2));
    expect(parseSince('7D', NOW)).toBe(NOW.getTime() - days(7));
  });

  it('reads absolute dates', () => {
    expect(parseSince('2026-07-01', NOW)).toBe(Date.parse('2026-07-01'));
    expect(parseSince('2026-07-01T10:00:00.000Z', NOW)).toBe(Date.parse('2026-07-01T10:00:00.000Z'));
  });

  it('returns null for nonsense so the caller can complain precisely', () => {
    expect(parseSince('last tuesday', NOW)).toBeNull();
    expect(parseSince('', NOW)).toBeNull();
    expect(parseSince('7y', NOW)).toBeNull();
  });
});

describe('import flags parse as values, not booleans', () => {
  // Every flag taking a value must be in util.ts's VALUE_FLAGS, or `--since 7d`
  // silently becomes `{since:true}` plus a stray positional "7d".
  it.each(['since', 'project', 'min-confidence', 'concurrency', 'max-new', 'limit', 'model'])(
    '--%s takes its value',
    (flag) => {
      const args = parseArgs([`--${flag}`, 'VALUE']);
      expect(args.flags[flag]).toBe('VALUE');
      expect(args.positional).toEqual([]);
    },
  );

  it.each(['all', 'apply', 'force', 'yes', 'global'])('--%s stays boolean', (flag) => {
    const args = parseArgs([`--${flag}`]);
    expect(args.flags[flag]).toBe(true);
  });

  it('keeps --apply boolean even when a path follows it', () => {
    const args = parseArgs(['--apply', 'somefile']);
    expect(args.flags.apply).toBe(true);
    expect(args.positional).toEqual(['somefile']);
  });
});
