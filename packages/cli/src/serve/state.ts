// Everything the request handlers need, in one object with an explicit reload
// policy. The server is long-lived, so nothing here may cache indefinitely:
// `nff-brain pair --reset` can rewrite serve.json underneath us, and both brain
// files change on every session.

import * as fs from 'node:fs';
import {
  RateBuckets,
  clipQueueStats,
  clipsPath,
  loadBrain,
  loadServeConfig,
  mergeBrains,
  mintServerIdentity,
  openPairingWindow,
  saveServeConfig,
  serveConfigPath,
} from '@nff-brain/core';
import type { BrainFile, CaptureTarget, PairingWindow, ServeConfig } from '@nff-brain/core';

export interface ServeOptions {
  port: number;
  workspaceRoot: string;
  projectBrainPath: string;
  globalBrainPath: string;
  allowOrigins: string[];
  cliVersion: string;
  /** Overridable so tests never touch the developer's real serve.json. */
  configFile?: string;
  defaultTarget?: CaptureTarget;
}

export interface BrainSummary {
  brainPath: string;
  exists: boolean;
  nodes: number;
  edges: number;
  updatedAt?: string;
  error?: string;
}

interface CachedBrain {
  sig: string;
  brain: BrainFile | null;
  error?: string;
}

function fileSig(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

export class ServeState {
  readonly startedAt = new Date().toISOString();
  readonly buckets = new RateBuckets();
  readonly configFile: string;

  /** Assigned after listen() resolves, since --port 0 picks the real one there. */
  port: number;

  pairing: PairingWindow | null = null;

  private cfg: ServeConfig;
  private cfgSig = '';
  private cfgCheckedAt = 0;
  private readonly brainCache = new Map<string, CachedBrain>();

  constructor(readonly opts: ServeOptions) {
    this.port = opts.port;
    this.configFile = opts.configFile ?? serveConfigPath();
    const existing = loadServeConfig(this.configFile);
    if (existing) {
      this.cfg = existing;
    } else {
      this.cfg = mintServerIdentity();
      if (opts.defaultTarget) this.cfg.capture.defaultTarget = opts.defaultTarget;
      saveServeConfig(this.cfg, this.configFile);
    }
    if (opts.defaultTarget && this.cfg.capture.defaultTarget !== opts.defaultTarget) {
      this.cfg.capture.defaultTarget = opts.defaultTarget;
      saveServeConfig(this.cfg, this.configFile);
    }
    this.cfgSig = fileSig(this.configFile);
  }

  /**
   * Re-read serve.json when it changes on disk, at most once a second. That is
   * one statSync on the hot path (~20µs) and it means `nff-brain pair --reset`
   * converges without any reload plumbing, fs watcher or restart.
   */
  config(): ServeConfig {
    const now = Date.now();
    if (now - this.cfgCheckedAt >= 1000) {
      this.cfgCheckedAt = now;
      const sig = fileSig(this.configFile);
      if (sig !== this.cfgSig) {
        this.cfgSig = sig;
        const fresh = loadServeConfig(this.configFile);
        // A corrupt or deleted file reads as "unpaired" rather than throwing,
        // but we keep our identity so an accidental delete does not silently
        // hand out a second serverId.
        if (fresh) this.cfg = fresh;
        else this.cfg.clients = [];
      }
    }
    return this.cfg;
  }

  saveConfig(cfg: ServeConfig): void {
    this.cfg = cfg;
    saveServeConfig(cfg, this.configFile);
    this.cfgSig = fileSig(this.configFile);
    this.cfgCheckedAt = Date.now();
  }

  /** Paired client origins plus any --allow-origin entries (unpacked dev builds). */
  allowedOrigins(): string[] {
    return [...this.config().clients.map((c) => c.origin), ...this.opts.allowOrigins];
  }

  /** Open a pairing window and hand back the plaintext code exactly once. */
  openPairing(now = Date.now()): string {
    const { window, code } = openPairingWindow(now);
    this.pairing = window;
    return code;
  }

  private brain(file: string): CachedBrain {
    const sig = fileSig(file);
    const hit = this.brainCache.get(file);
    if (hit && hit.sig === sig) return hit;
    let entry: CachedBrain;
    try {
      entry = { sig, brain: loadBrain(file) };
    } catch (err) {
      // A brain we cannot parse must degrade to an error field, never a 500 —
      // the popup still needs to report "connected".
      entry = { sig, brain: null, error: err instanceof Error ? err.message : String(err) };
    }
    this.brainCache.set(file, entry);
    return entry;
  }

  summarize(file: string): BrainSummary {
    const { brain, error } = this.brain(file);
    if (error) return { brainPath: file, exists: true, nodes: 0, edges: 0, error };
    if (!brain) return { brainPath: file, exists: false, nodes: 0, edges: 0 };
    return {
      brainPath: file,
      exists: true,
      nodes: brain.nodes.length,
      edges: brain.edges.length,
      updatedAt: brain.updatedAt,
    };
  }

  /** What RECALL actually sees — project wins on id collision, global fills in. */
  mergedCounts(): { nodes: number; edges: number } {
    const merged = mergeBrains(this.brain(this.opts.projectBrainPath).brain, this.brain(this.opts.globalBrainPath).brain);
    return { nodes: merged.nodes.length, edges: merged.edges.length };
  }

  targetBrainPath(target: CaptureTarget): string {
    return target === 'project' ? this.opts.projectBrainPath : this.opts.globalBrainPath;
  }

  queueStats(target: CaptureTarget = this.config().capture.defaultTarget) {
    const brainPath = this.targetBrainPath(target);
    // The reported path is the QUEUE file, not the brain beside it — this is
    // what the banner, /v1/status and doctor all show the user.
    return { path: clipsPath(brainPath), ...clipQueueStats(brainPath) };
  }
}
