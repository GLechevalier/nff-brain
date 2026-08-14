// Typed convenience wrapper over the fixture server's command channel — the
// harness's ONLY hand inside the browser (no CDP; see harness/chrome.ts).

import type { FixtureHandle } from './fixtures.js';
import type { ActRunView, BenchCmd, BenchTabInfo, BenchVerbResult } from '@nff-brain/core/benchProtocol';
import type { PageSnapshot } from '@nff-brain/core/pageSnapshot';

export class BenchDriverError extends Error {}

export interface VerbOutcome extends BenchVerbResult {
  snapshot?: PageSnapshot;
}

export class DriverClient {
  constructor(private readonly fx: FixtureHandle) {}

  /** Send a command; throws BenchDriverError when the driver reports ok:false. */
  private async cmd<T = unknown>(cmd: BenchCmd, timeoutMs?: number): Promise<T> {
    const res = await this.fx.sendCmd(cmd, timeoutMs);
    if (!res.ok) throw new BenchDriverError(`${cmd.kind}: ${res.error ?? 'driver reported failure'}`);
    return res.data as T;
  }

  ping(): Promise<{ extVersion: string }> {
    return this.cmd({ kind: 'ping' }, 15_000);
  }

  pair(port: number, code: string): Promise<void> {
    return this.cmd({ kind: 'pair', port, code });
  }

  setHostAllow(origin: string, choice: 'always' | 'never'): Promise<void> {
    return this.cmd({ kind: 'setHostAllow', origin, choice });
  }

  async openTab(url: string): Promise<number> {
    const { tabId } = await this.cmd<{ tabId: number }>({ kind: 'openTab', url });
    return tabId;
  }

  closeTab(tabId: number): Promise<void> {
    return this.cmd({ kind: 'closeTab', tabId });
  }

  listTabs(): Promise<BenchTabInfo[]> {
    return this.cmd({ kind: 'listTabs' });
  }

  attach(tabId: number): Promise<void> {
    return this.cmd({ kind: 'attach', tabId });
  }

  detachAll(): Promise<void> {
    return this.cmd({ kind: 'detachAll' });
  }

  /**
   * Execute one BrowserVerb. The ENGINE's failure ("occluded", "stale ref")
   * comes back as data.ok:false with the engine's resultText — that is a
   * measurable outcome, not a transport error, so it does not throw.
   */
  verb(tabId: number, verb: Record<string, unknown>, timeoutMs?: number): Promise<VerbOutcome> {
    return this.cmd<VerbOutcome>({ kind: 'verb', tabId, verb }, timeoutMs);
  }

  /** verb() + throw when the ENGINE refused — for steps that must succeed. */
  async mustVerb(tabId: number, verb: Record<string, unknown>, timeoutMs?: number): Promise<VerbOutcome> {
    const r = await this.verb(tabId, verb, timeoutMs);
    if (!r.ok) throw new BenchDriverError(`${String(verb.kind)}: engine refused — ${r.resultText}`);
    return r;
  }

  /** page.read convenience — returns the snapshot or throws. */
  async read(tabId: number, mode: 'interactive' | 'text' = 'interactive'): Promise<PageSnapshot> {
    const r = await this.mustVerb(tabId, { kind: 'page.read', mode });
    if (!r.snapshot) throw new BenchDriverError('page.read returned no snapshot');
    return r.snapshot;
  }

  async getZoom(tabId: number): Promise<number> {
    const { zoom } = await this.cmd<{ zoom: number }>({ kind: 'getZoom', tabId });
    return zoom;
  }

  actStart(goal: string, tabId: number, maxActions?: number, mode: 'manual' | 'plan' | 'auto' = 'auto'): Promise<{ runId?: string; awaitingGrant?: boolean }> {
    return this.cmd({ kind: 'actStart', goal, tabId, maxActions, mode });
  }

  actStatus(): Promise<ActRunView | null> {
    return this.cmd({ kind: 'actStatus' }, 15_000);
  }

  actGrant(choice: 'once' | 'always' | 'never'): Promise<void> {
    return this.cmd({ kind: 'actGrant', choice });
  }

  actStop(): Promise<void> {
    return this.cmd({ kind: 'actStop' });
  }

  actEnd(): Promise<void> {
    return this.cmd({ kind: 'actEnd' });
  }

  /** Find a snapshot element by accessible name substring (case-insensitive). */
  findRef(snap: PageSnapshot, nameSub: string, role?: string): { ref: string; snapshotId: string } {
    const needle = nameSub.toLowerCase();
    const el = snap.elements.find(
      (e) => (role === undefined || e.role === role) && (e.name ?? '').toLowerCase().includes(needle),
    );
    if (!el) {
      const have = snap.elements.slice(0, 30).map((e) => `${e.role}:"${e.name}"`).join(', ');
      throw new BenchDriverError(`no snapshot element matching ${role ?? '*'}:"${nameSub}" — have: ${have}`);
    }
    return { ref: el.ref, snapshotId: snap.snapshotId };
  }
}
