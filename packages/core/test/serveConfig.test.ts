import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addClient,
  findClientById,
  findClientByOrigin,
  isInstanceAlive,
  loadServeConfig,
  mintServerIdentity,
  readInstance,
  removeClient,
  saveServeConfig,
  serveConfigMode,
  tokenMatches,
  writeInstance,
} from '../src/index.js';
import type { ServeInstance } from '../src/index.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const WORKSPACE = '/tmp/ws';

let dir: string;
let cfgFile: string;
let instFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-serve-'));
  cfgFile = path.join(dir, 'serve.json');
  instFile = path.join(dir, 'serve-instance.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mintServerIdentity', () => {
  it('produces a srv_ id and a 43-char admin token', () => {
    const cfg = mintServerIdentity();
    expect(cfg.serverId).toMatch(/^srv_[0-9a-f]{16}$/);
    expect(cfg.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg.clients).toEqual([]);
    expect(cfg.capture.defaultTarget).toBe('global');
  });
});

describe('serve.json round trip', () => {
  it('loads back what it saved', () => {
    const cfg = mintServerIdentity();
    addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    saveServeConfig(cfg, cfgFile);

    const back = loadServeConfig(cfgFile)!;
    expect(back.serverId).toBe(cfg.serverId);
    expect(back.adminToken).toBe(cfg.adminToken);
    expect(back.clients).toHaveLength(1);
    expect(back.clients[0]!.origin).toBe(ORIGIN);
  });

  it('never writes a client token in the clear', () => {
    const cfg = mintServerIdentity();
    const { token } = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    saveServeConfig(cfg, cfgFile);

    const onDisk = fs.readFileSync(cfgFile, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(JSON.stringify(cfg)).not.toContain(token);
    // …but the stored hash still verifies it.
    expect(tokenMatches(token, cfg.clients[0]!.tokenHash)).toBe(true);
  });

  it('returns null for a missing file', () => {
    expect(loadServeConfig(path.join(dir, 'nope.json'))).toBeNull();
  });

  it.each([
    ['not json at all', '{{{'],
    ['json without a serverId', '{"version":1,"clients":[]}'],
    ['a bare array', '[]'],
  ])('reads %s as unpaired rather than throwing', (_label, raw) => {
    fs.writeFileSync(cfgFile, raw);
    expect(loadServeConfig(cfgFile)).toBeNull();
  });

  it('drops malformed client entries instead of trusting them', () => {
    const cfg = mintServerIdentity();
    saveServeConfig(cfg, cfgFile);
    const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    raw.clients = [{ id: 'cl_x' }, null, 'nope'];
    fs.writeFileSync(cfgFile, JSON.stringify(raw));
    expect(loadServeConfig(cfgFile)!.clients).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes 0600, including over a pre-existing 0644', () => {
    fs.writeFileSync(cfgFile, '{}', { mode: 0o644 });
    fs.chmodSync(cfgFile, 0o644);
    saveServeConfig(mintServerIdentity(), cfgFile);
    expect(serveConfigMode(cfgFile)).toBe(0o600);
  });
});

describe('clients', () => {
  it('finds by origin and by id', () => {
    const cfg = mintServerIdentity();
    const { client } = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    expect(findClientByOrigin(cfg, ORIGIN)!.id).toBe(client.id);
    expect(findClientById(cfg, client.id)!.origin).toBe(ORIGIN);
    expect(findClientByOrigin(cfg, 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba')).toBeUndefined();
  });

  it('replaces rather than accumulates when the same origin re-pairs', () => {
    // Dev reloads re-pair constantly; the list must not grow without bound.
    const cfg = mintServerIdentity();
    const first = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    const second = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    expect(cfg.clients).toHaveLength(1);
    expect(tokenMatches(second.token, cfg.clients[0]!.tokenHash)).toBe(true);
    expect(tokenMatches(first.token, cfg.clients[0]!.tokenHash)).toBe(false);
  });

  it('removes by id and reports whether anything went', () => {
    const cfg = mintServerIdentity();
    const { client } = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    expect(removeClient(cfg, client.id)).toBe(true);
    expect(removeClient(cfg, client.id)).toBe(false);
    expect(cfg.clients).toEqual([]);
  });

  it('stamps and persists the workspaceRoot at pair time', () => {
    const cfg = mintServerIdentity();
    const { client } = addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    expect(client.workspaceRoot).toBe(WORKSPACE);
    saveServeConfig(cfg, cfgFile);
    expect(loadServeConfig(cfgFile)!.clients[0]!.workspaceRoot).toBe(WORKSPACE);
  });

  it('loads a legacy client with no workspaceRoot rather than dropping it', () => {
    const cfg = mintServerIdentity();
    addClient(cfg, { name: 'Chrome extension', origin: ORIGIN, workspaceRoot: WORKSPACE });
    saveServeConfig(cfg, cfgFile);
    const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    delete raw.clients[0].workspaceRoot;
    fs.writeFileSync(cfgFile, JSON.stringify(raw));
    const back = loadServeConfig(cfgFile)!;
    expect(back.clients).toHaveLength(1);
    expect(back.clients[0]!.workspaceRoot).toBeUndefined();
  });

  it('gives each client an independent token', () => {
    const cfg = mintServerIdentity();
    const a = addClient(cfg, {
      name: 'A',
      origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceRoot: WORKSPACE,
    });
    const b = addClient(cfg, {
      name: 'B',
      origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      workspaceRoot: WORKSPACE,
    });
    expect(a.token).not.toBe(b.token);
    expect(tokenMatches(a.token, cfg.clients[1]!.tokenHash)).toBe(false);
  });
});

describe('serve-instance.json', () => {
  const inst: ServeInstance = {
    version: 1,
    pid: process.pid,
    port: 7373,
    serverId: 'srv_0000000000000000',
    workspaceRoot: '/tmp/ws',
    startedAt: new Date(0).toISOString(),
    cliVersion: '0.0.0',
  };

  it('round trips', () => {
    writeInstance(inst, instFile);
    expect(readInstance(instFile)).toEqual(inst);
  });

  it('returns null for a missing or malformed record', () => {
    expect(readInstance(instFile)).toBeNull();
    fs.writeFileSync(instFile, '{"pid":"nope"}');
    expect(readInstance(instFile)).toBeNull();
  });

  it('detects a live pid and a stale one', () => {
    expect(isInstanceAlive(inst)).toBe(true);
    // pid 1 exists everywhere; a very high pid effectively never does.
    expect(isInstanceAlive({ ...inst, pid: 0x7ffffffe })).toBe(false);
    expect(isInstanceAlive(null)).toBe(false);
  });
});
