// NFF_BRAIN_HOME redirects the GLOBAL nff-brain data dir without touching
// HOME/USERPROFILE — the eval harness depends on this so a tier-3 run can
// isolate brain/serve/web-agent state while the spawned `claude` CLI keeps
// its real ~/.claude auth. Every global-path builder must honor it.
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brainHomeDir, globalBrainPath, runtimeDir, embedCacheDir, BRAIN_DIR } from '../src/paths.js';
import { mcpServersPath } from '../src/mcpServers.js';
import { serveConfigPath, serveInstancePath } from '../src/serveConfig.js';
import { webAgentStatePath } from '../src/webAgentState.js';

const saved = process.env.NFF_BRAIN_HOME;

afterEach(() => {
  if (saved === undefined) delete process.env.NFF_BRAIN_HOME;
  else process.env.NFF_BRAIN_HOME = saved;
});

describe('brainHomeDir', () => {
  it('defaults to ~/.nff-brain', () => {
    delete process.env.NFF_BRAIN_HOME;
    expect(brainHomeDir()).toBe(path.join(os.homedir(), BRAIN_DIR));
  });

  it('an empty/whitespace override is ignored, not treated as cwd', () => {
    process.env.NFF_BRAIN_HOME = '  ';
    expect(brainHomeDir()).toBe(path.join(os.homedir(), BRAIN_DIR));
  });

  it('redirects every global path builder', () => {
    const home = path.join(os.tmpdir(), 'nff-brain-home-test');
    process.env.NFF_BRAIN_HOME = home;
    const resolved = path.resolve(home);
    expect(brainHomeDir()).toBe(resolved);
    expect(globalBrainPath()).toBe(path.join(resolved, 'brain.json'));
    expect(mcpServersPath()).toBe(path.join(resolved, 'mcp-servers.json'));
    expect(serveConfigPath()).toBe(path.join(resolved, 'serve.json'));
    expect(serveInstancePath()).toBe(path.join(resolved, 'serve-instance.json'));
    expect(webAgentStatePath()).toBe(path.join(resolved, 'web-agent.json'));
    expect(runtimeDir()).toBe(path.join(resolved, 'runtime'));
    expect(embedCacheDir()).toBe(path.join(resolved, 'models'));
  });

  it('explicit NFF_BRAIN_RUNTIME_DIR still outranks the home override', () => {
    process.env.NFF_BRAIN_HOME = path.join(os.tmpdir(), 'nff-brain-home-test');
    const prev = process.env.NFF_BRAIN_RUNTIME_DIR;
    process.env.NFF_BRAIN_RUNTIME_DIR = path.join(os.tmpdir(), 'rt');
    try {
      expect(runtimeDir()).toBe(path.join(os.tmpdir(), 'rt'));
    } finally {
      if (prev === undefined) delete process.env.NFF_BRAIN_RUNTIME_DIR;
      else process.env.NFF_BRAIN_RUNTIME_DIR = prev;
    }
  });
});
