import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANONICAL } from '../../core/test/skillFixture.js';

// End-to-end over the BUILT CLI: a BRAIN-NODE.json skill tree goes in, reaches
// a session through recall as a rendered SKILL.md, and comes back out byte for
// byte. No `claude` shim is needed — nothing on this path calls an LLM.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'index.js');

let ws: string;
let fakeHome: string;

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, NFF_BRAIN_SKIP: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const SKILL_FILE = 'skills/li-read-card.BRAIN-NODE.json';
const brainPath = () => path.join(ws, '.nff-brain', 'brain.json');
const readBrain = () => JSON.parse(fs.readFileSync(brainPath(), 'utf8'));

beforeAll(() => {
  expect(fs.existsSync(CLI), `built CLI missing at ${CLI} — run npm run build -w nff-brain`).toBe(true);
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-skill-e2e-home-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-skill-e2e-ws-'));
  fs.mkdirSync(path.join(ws, '.git'));
  fs.mkdirSync(path.join(ws, 'skills'));
  fs.writeFileSync(path.join(ws, SKILL_FILE), CANONICAL);
});

afterAll(() => {
  for (const dir of [ws, fakeHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle briefly */
    }
  }
});

describe('nff-brain skill (e2e)', () => {
  it('--dry-run prints the plan and writes nothing', () => {
    const r = runCli(['skill', 'add', SKILL_FILE, '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing written (--dry-run)');
    expect(r.stdout).toContain('sk-li-read-card-scroll-retry');
    expect(fs.existsSync(brainPath())).toBe(false);
  });

  it('add expands the tree into one node per step', () => {
    const r = runCli(['skill', 'add', SKILL_FILE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('5 created');
    const brain = readBrain();
    const skills = brain.nodes.filter((n: { skill?: unknown }) => n.skill);
    expect(skills).toHaveLength(5);
    // Curated + strategy: inherits the existing eviction exemptions.
    for (const n of skills) {
      expect(n.origin).toBe('seed');
      expect(n.category).toBe('strategy');
    }
  });

  it('list shows the tree with its shape', () => {
    const r = runCli(['skill', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('li-read-card');
    expect(r.stdout).toContain('5 nodes');
    expect(r.stdout).toContain('2 alts');
  });

  it('re-adding is an idempotent upsert, not a duplicate', () => {
    const before = readBrain().nodes.length;
    const r = runCli(['skill', 'add', SKILL_FILE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 created');
    expect(readBrain().nodes.length).toBe(before);
  });

  it('recall injects it as a rendered SKILL.md, not as one bullet per step', () => {
    // The Done-when for the whole format: a skill reaches a session as a
    // procedure whose alternatives are visible.
    const r = runCli(['recall', '--query', 'read the role and company off a linkedin result card']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('### SKILL: Read role and company off a LinkedIn result card');
    expect(r.stdout).toContain('— either of these, in this order —');
    expect(r.stdout).toContain('2a. Scroll the card into view and re-read');
    expect(r.stdout).toContain('if this fails, try: "Open the profile and read the headline"');
    // No node ids, and no step rendered as a flat bullet.
    expect(r.stdout).not.toContain('sk-li-read-card');
    expect(r.stdout).not.toMatch(/^- \[strategy\] Scroll the card/m);
  });

  it('export round-trips byte for byte', () => {
    const out = path.join(ws, 'exported.json');
    const r = runCli(['skill', 'export', 'li-read-card', '--out', out]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(CANONICAL);
  });

  it('export still round-trips after usage has written learned state', () => {
    // Runtime state is brain state, not skill definition — otherwise every
    // export after a session would show a spurious diff.
    const brain = readBrain();
    const mark = (id: string, outcome: { tried: number; worked: number; failed: number }) => {
      const n = brain.nodes.find((x: { id: string }) => x.id === id);
      n.recallCount = 7;
      n.skill.outcome = outcome;
      n.confidence = (outcome.worked + 1) / (outcome.tried + 2);
    };
    // The authored first choice kept failing; the fallback kept working.
    mark('sk-li-read-card-scroll-retry', { tried: 4, worked: 0, failed: 4 });
    mark('sk-li-read-card-open-profile', { tried: 4, worked: 4, failed: 0 });
    fs.writeFileSync(brainPath(), JSON.stringify(brain, null, 2) + '\n');

    const out = path.join(ws, 'exported2.json');
    expect(runCli(['skill', 'export', 'li-read-card', '--out', out]).status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(CANONICAL);
  });

  it('recall now offers the branch that actually worked first', () => {
    // The learning loop, end to end. Note an UNTRIED branch keeps its authored
    // position — only a branch that measurably lost ground gives it up.
    const r = runCli(['recall', '--query', 'read the role and company off a linkedin result card']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2a. Open the profile and read the headline   [worked 4/4]');
    expect(r.stdout).toContain('2b. Scroll the card into view and re-read   [worked 0/4]');
    expect(r.stdout.indexOf('Open the profile')).toBeLessThan(r.stdout.indexOf('Scroll the card into view'));
  });

  it('fmt --check accepts the canonical file and rejects a scrambled one', () => {
    expect(runCli(['skill', 'fmt', SKILL_FILE, '--check']).status).toBe(0);

    const messy = 'skills/messy.BRAIN-NODE.json';
    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    fs.writeFileSync(
      path.join(ws, messy),
      JSON.stringify({ steps: doc.steps, tree: doc.tree, title: doc.title, content: doc.content, format: doc.format, version: doc.version, when: doc.when, verify: doc.verify, tags: doc.tags }),
    );
    expect(runCli(['skill', 'fmt', messy, '--check']).status).toBe(1);
    expect(runCli(['skill', 'fmt', messy]).status).toBe(0);
    expect(runCli(['skill', 'fmt', messy, '--check']).status).toBe(0);
    expect(fs.readFileSync(path.join(ws, messy), 'utf8')).toBe(CANONICAL);
  });

  it('refuses a malformed file with a message that names the problem', () => {
    const bad = 'skills/bad.BRAIN-NODE.json';
    const doc = JSON.parse(CANONICAL) as Record<string, unknown>;
    delete (doc.steps as Array<Record<string, unknown>>)[0].content;
    fs.writeFileSync(path.join(ws, bad), JSON.stringify(doc));
    const r = runCli(['skill', 'add', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('steps[0].content is required');
  });

  it('relink restores a parent link deleted out from under the tree', () => {
    const brain = readBrain();
    brain.edges = brain.edges.filter(
      (e: { from: string; to: string }) =>
        !(e.from === 'sk-li-read-card-subtitle-missing' && e.to === 'sk-li-read-card-scroll-retry'),
    );
    fs.writeFileSync(brainPath(), JSON.stringify(brain, null, 2) + '\n');

    const r = runCli(['skill', 'relink', 'li-read-card']);
    expect(r.status).toBe(0);
    expect(
      readBrain().edges.some(
        (e: { from: string; to: string }) =>
          e.from === 'sk-li-read-card-subtitle-missing' && e.to === 'sk-li-read-card-scroll-retry',
      ),
    ).toBe(true);
  });
});
