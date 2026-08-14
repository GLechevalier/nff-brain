import { describe, expect, it } from 'vitest';
import {
  BENCH_POLL_HOLD_MS,
  BENCH_SENTINEL,
  isBenchCmdKind,
  isBenchPageReport,
  isBenchPollCmd,
} from '../src/benchProtocol.js';

describe('benchProtocol', () => {
  it('holds polls well under the MV3 ~30s idle kill', () => {
    expect(BENCH_POLL_HOLD_MS).toBeLessThanOrEqual(25_000);
  });

  it('the sentinel is a plain string literal (survives minification as-is)', () => {
    expect(BENCH_SENTINEL).toBe('__NFF_BENCH_DRIVER__');
  });

  it('recognizes every command kind and rejects strangers', () => {
    for (const k of ['ping', 'verb', 'actStart', 'actGrant', 'detachAll']) {
      expect(isBenchCmdKind(k), k).toBe(true);
    }
    expect(isBenchCmdKind('rm-rf')).toBe(false);
    expect(isBenchCmdKind(3)).toBe(false);
    expect(isBenchCmdKind(undefined)).toBe(false);
  });

  it('validates poll-command envelopes shallowly', () => {
    expect(isBenchPollCmd({ cmdId: 'c1', cmd: { kind: 'ping' } })).toBe(true);
    expect(isBenchPollCmd({ cmdId: 'c1', cmd: { kind: 'nope' } })).toBe(false);
    expect(isBenchPollCmd({ cmdId: '', cmd: { kind: 'ping' } })).toBe(false);
    expect(isBenchPollCmd({ retire: true })).toBe(false);
    expect(isBenchPollCmd(null)).toBe(false);
  });

  it('validates page reports shallowly', () => {
    expect(isBenchPageReport({ run: 'a1', page: 'pointer.html', instance: 'i1', events: [] })).toBe(true);
    expect(isBenchPageReport({ run: 'a1', page: 'pointer.html', events: [] })).toBe(false);
    expect(isBenchPageReport('nope')).toBe(false);
  });
});
