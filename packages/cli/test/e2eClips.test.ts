import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// End-to-end over the BUILT CLI with the mocked `claude` shim: the CLIP DRAIN.
// The epic's Done-when in miniature — clips land in the queue, a SessionEnd
// hook (with a transcript far too short to distill) mints nodes from them, and
// the next recall injects a [clip] line.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');
const SHIM_JS = path.join(here, 'fixtures', 'claude-shim.mjs');

let ws: string;
let shimDir: string;
let shimBin: string;
let fakeHome: string;

function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws,
    input: opts.stdin,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NFF_BRAIN_CLAUDE_BIN: shimBin,
      NFF_BRAIN_TIMEOUT_MS: '5000',
      NFF_BRAIN_SKIP: '',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const globalBrainDir = () => path.join(fakeHome, '.nff-brain');
const projectBrainDir = () => path.join(ws, '.nff-brain');

function readBrain(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, 'brain.json'), 'utf8'));
}

function clipLine(id: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      v: 1,
      id,
      at: new Date().toISOString(),
      kind: 'selection',
      text: `captured text for ${id}`,
      target: 'global',
      source: 'chrome',
      clientId: 'cl_test01',
      ...extra,
    }) + '\n'
  );
}

function seedQueues(): void {
  fs.mkdirSync(globalBrainDir(), { recursive: true });
  fs.mkdirSync(projectBrainDir(), { recursive: true });
  // Batch order is global-take then project-take: index 0 → shim's strategy
  // entry, index 1 → the rules entry.
  fs.writeFileSync(
    path.join(globalBrainDir(), 'clips.jsonl'),
    clipLine('clp_1_aaaaaa', { url: 'https://mqtt.example.org/docs', title: 'MQTT docs' }),
  );
  fs.writeFileSync(
    path.join(projectBrainDir(), 'clips.jsonl'),
    clipLine('clp_2_bbbbbb', { target: 'project', workspaceRoot: ws, url: 'https://cors.example.org/guide' }),
  );
}

/** A hook payload whose transcript is far too short for the transcript distill. */
function shortSessionPayload(): string {
  const transcript = path.join(ws, 'short.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  return JSON.stringify({ session_id: 'sess-clips', transcript_path: transcript, cwd: ws });
}

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-clip-e2e-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-clip-e2e-ws-'));
  fs.mkdirSync(path.join(ws, '.git'));

  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-clip-e2e-shim-'));
  if (process.platform === 'win32') {
    shimBin = path.join(shimDir, 'claude.cmd');
    fs.writeFileSync(shimBin, `@echo off\r\nnode "${SHIM_JS}" %*\r\n`);
  } else {
    shimBin = path.join(shimDir, 'claude');
    fs.writeFileSync(shimBin, `#!/bin/sh\nexec node "${SHIM_JS}" "$@"\n`);
    fs.chmodSync(shimBin, 0o755);
  }
});

afterAll(async () => {
  for (const dir of [ws, shimDir, fakeHome]) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
});

describe('e2e clip drain (mocked claude)', () => {
  it('a short-transcript SessionEnd still drains both queues into both brains', () => {
    seedQueues();
    const r = runCli(['distill', '--stdin-hook'], { stdin: shortSessionPayload() });
    expect(r.status).toBe(0);

    const global = readBrain(globalBrainDir());
    const mqtt = global.nodes.find((n: any) => n.id === 'mqtt-keepalive-default');
    expect(mqtt).toBeTruthy();
    expect(mqtt.origin).toBe('clip');
    expect(mqtt.sourceUrl).toBe('https://mqtt.example.org/docs');

    const project = readBrain(projectBrainDir());
    const cors = project.nodes.find((n: any) => n.id === 'cors-preflight-before-auth');
    expect(cors).toBeTruthy();
    expect(cors.origin).toBe('clip');

    // The transcript distill was skipped (too short) — no agent nodes appeared.
    expect(global.nodes.every((n: any) => n.origin === 'clip')).toBe(true);

    // Both queues were consumed and the ledgers written with the mapping.
    expect(fs.existsSync(path.join(globalBrainDir(), 'clips.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(globalBrainDir(), 'clips.processing.jsonl'))).toBe(false);
    const ledger = fs.readFileSync(path.join(globalBrainDir(), 'clip-map.jsonl'), 'utf8');
    const entry = JSON.parse(ledger.trim().split('\n')[0]);
    expect(entry.clipId).toBe('clp_1_aaaaaa');
    expect(entry.clientId).toBe('cl_test01');
    expect(entry.nodeIds).toEqual(['mqtt-keepalive-default']);
  });

  it('redelivered clips are absorbed by the ledger — nothing minted twice', () => {
    const before = readBrain(globalBrainDir()).nodes.length;
    // Simulate at-least-once redelivery: the same records land in the queue again.
    fs.writeFileSync(
      path.join(globalBrainDir(), 'clips.jsonl'),
      clipLine('clp_1_aaaaaa', { url: 'https://mqtt.example.org/docs' }),
    );
    const r = runCli(['distill', '--stdin-hook'], { stdin: shortSessionPayload() });
    expect(r.status).toBe(0);
    expect(readBrain(globalBrainDir()).nodes.length).toBe(before);
    expect(fs.existsSync(path.join(globalBrainDir(), 'clips.jsonl'))).toBe(false); // consumed, not left
  });

  it('recall injects the clip as a [clip] line with its source host', () => {
    const r = runCli(['recall', '--query', 'mqtt keepalive dropping']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[clip] MQTT keepalive default');
    expect(r.stdout).toContain('(from mqtt.example.org)');
  });

  it('`clips` lists pending captures and `clips --drain` mints without a session', () => {
    fs.writeFileSync(
      path.join(globalBrainDir(), 'clips.jsonl'),
      clipLine('clp_3_cccccc', { url: 'https://fresh.example.org/x', text: 'fresh capture text' }),
    );
    const list = runCli(['clips']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('1 pending');
    expect(list.stdout).toContain('fresh capture text');

    const drain = runCli(['clips', '--drain']);
    expect(drain.status).toBe(0);
    expect(drain.stdout).toMatch(/1 clip\(s\) processed/);
    // The shim maps index 0 → the strategy node; it already exists, so this is
    // a refine, not a create — either way the queue is consumed and ledgered.
    expect(fs.existsSync(path.join(globalBrainDir(), 'clips.jsonl'))).toBe(false);
  });
});
