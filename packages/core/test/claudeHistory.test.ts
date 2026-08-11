import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeHome,
  discoverSessions,
  encodeProjectDirVariants,
  liveSessionIds,
  probeSession,
  promptCountForPath,
  samePath,
} from '../src/index.js';

let home: string;
let projects: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nff-brain-history-'));
  projects = path.join(home, 'projects');
  fs.mkdirSync(projects, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const env = () => ({ NFF_BRAIN_CLAUDE_HOME: home }) as NodeJS.ProcessEnv;

interface SessionSpec {
  cwd?: string;
  titles?: string[]; // ai-title records, in file order — the LAST should win
  prompts?: string[]; // typed user messages
  assistantTurns?: number;
  pad?: number; // filler bytes, to clear the minBytes floor
  isSidechain?: boolean;
  version?: string;
}

/** Write a synthetic transcript shaped like a real Claude Code one. */
function writeSession(dirName: string, sessionId: string, spec: SessionSpec = {}): string {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];

  // Real transcripts open with state records that carry NO cwd — the importer
  // must scan forward rather than trusting the first line.
  lines.push(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }));
  lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }));

  const base = {
    sessionId,
    cwd: spec.cwd ?? 'D:\\work\\demo',
    version: spec.version ?? '2.1.210',
    gitBranch: 'main',
    ...(spec.isSidechain ? { isSidechain: true } : {}),
  };

  const prompts = spec.prompts ?? ['Fix the login bug'];
  prompts.forEach((p, i) => {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', content: p },
        timestamp: `2026-08-0${i + 1}T10:00:00.000Z`,
      }),
    );
  });

  for (let i = 0; i < (spec.assistantTurns ?? 1); i++) {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'y'.repeat(spec.pad ?? 200)}` }] },
        timestamp: `2026-08-09T10:00:0${i}.000Z`,
      }),
    );
  }

  for (const t of spec.titles ?? []) {
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId }));
  }

  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

describe('claudeHome', () => {
  it('prefers the test override, then CLAUDE_CONFIG_DIR', () => {
    expect(claudeHome({ NFF_BRAIN_CLAUDE_HOME: '/a', CLAUDE_CONFIG_DIR: '/b' } as NodeJS.ProcessEnv)).toBe('/a');
    expect(claudeHome({ CLAUDE_CONFIG_DIR: '/b' } as NodeJS.ProcessEnv)).toBe('/b');
    expect(claudeHome({} as NodeJS.ProcessEnv)).toContain('.claude');
  });
});

describe('encodeProjectDirVariants', () => {
  it('encodes the current scheme and the legacy underscore-preserving one', () => {
    const v = encodeProjectDirVariants('D:\\IntraMap\\Carto\\R_D\\MCPIOT\\nff_cli_mcp');
    // Both real forms exist on disk for the same path — see the module header.
    expect(v).toContain('D--IntraMap-Carto-R-D-MCPIOT-nff-cli-mcp');
    expect(v).toContain('D--IntraMap-Carto-R_D-MCPIOT-nff_cli_mcp');
  });

  it('collapses to a single variant when there are no underscores', () => {
    expect(encodeProjectDirVariants('D:\\work\\demo')).toHaveLength(1);
  });
});

describe('samePath', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(samePath('D:\\work\\demo', 'D:/work/demo/')).toBe(true);
    expect(samePath('D:\\work\\demo', 'D:\\work\\other')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('is case-insensitive on Windows', () => {
    expect(samePath('D:\\Work\\Demo', 'd:\\work\\demo')).toBe(true);
  });
});

describe('probeSession', () => {
  it('reads cwd from a NON-first record', () => {
    const f = writeSession('enc', 's1', { cwd: 'D:\\work\\demo' });
    const m = probeSession(f);
    expect(m.cwd).toBe('D:\\work\\demo');
    expect(m.version).toBe('2.1.210');
    expect(m.gitBranch).toBe('main');
  });

  it('keeps the LAST ai-title, not the first', () => {
    const f = writeSession('enc', 's1', { titles: ['early guess', 'the real subject'] });
    expect(probeSession(f).title).toBe('the real subject');
  });

  it('finds the last title in a file far bigger than the head window', () => {
    const dir = path.join(projects, 'enc');
    fs.mkdirSync(dir, { recursive: true });
    const filler = Array.from({ length: 2_000 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        cwd: 'D:\\work\\demo',
        message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(300) }] },
      }),
    );
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'first title' }),
      JSON.stringify({ type: 'user', cwd: 'D:\\work\\demo', message: { role: 'user', content: 'do a thing' } }),
      JSON.stringify({ type: 'user', cwd: 'D:\\work\\demo', message: { role: 'user', content: 'and another' } }),
      ...filler,
      JSON.stringify({ type: 'ai-title', aiTitle: 'final title' }),
    ];
    const f = path.join(dir, 'big.jsonl');
    fs.writeFileSync(f, lines.join('\n'));
    expect(fs.statSync(f).size).toBeGreaterThan(600_000); // well past both windows

    const m = probeSession(f);
    expect(m.title).toBe('final title'); // from the tail window
    expect(m.cwd).toBe('D:\\work\\demo'); // from the head window
  });

  it('counts only typed prompts as user turns, not tool results', () => {
    const dir = path.join(projects, 'enc');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'tr.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', cwd: 'D:\\w', message: { role: 'user', content: 'real prompt' } }),
        // tool results are arrays, and must not inflate the turn count
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] },
        }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>noise</system-reminder>' } }),
      ].join('\n'),
    );
    const m = probeSession(f);
    expect(m.userTurns).toBe(1);
    expect(m.firstPrompt).toBe('real prompt');
  });

  it('survives a missing file and a garbage file', () => {
    expect(probeSession(path.join(projects, 'nope.jsonl')).cwd).toBeNull();
    const dir = path.join(projects, 'enc');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'junk.jsonl');
    fs.writeFileSync(f, 'not json\n{"broken":\n');
    expect(() => probeSession(f)).not.toThrow();
  });
});

describe('one-shot classification', () => {
  it("flags nff-brain's OWN claude -p calls, however many turns they show", () => {
    const f = writeSession('enc', 'p1', {
      prompts: ['You are the memory distiller for a coding agent working on this project.'],
      titles: ['looks like a real session'],
    });
    expect(probeSession(f).kind).toBe('oneshot');
  });

  it('flags a single-turn untitled session', () => {
    const f = writeSession('enc', 'p2', { prompts: ['one off question'] });
    expect(probeSession(f).kind).toBe('oneshot');
  });

  it('keeps a session that has a title even with one prompt', () => {
    const f = writeSession('enc', 'p3', { prompts: ['one off'], titles: ['Real work happened'] });
    expect(probeSession(f).kind).toBe('interactive');
  });

  it('keeps a multi-turn session with no title', () => {
    const f = writeSession('enc', 'p4', { prompts: ['a', 'b', 'c'] });
    expect(probeSession(f).kind).toBe('interactive');
  });

  it('keeps a LARGE untitled session whose turns probe as 1', () => {
    // Real sessions run to ~1 MB with the middle outside both probe windows, so
    // userTurns undercounts to 1. Size alone must rescue them, or a whole class
    // of real history is silently dropped.
    const f = writeSession('enc', 'p5', { prompts: ['just one visible prompt'], assistantTurns: 1, pad: 300_000 });
    const m = probeSession(f);
    expect(m.bytes).toBeGreaterThan(200 * 1024);
    expect(m.userTurns).toBe(1);
    expect(m.title).toBeNull();
    expect(m.kind).toBe('interactive');
  });

  it('still flags a LARGE nff-brain prompt as a one-shot', () => {
    // The marker outranks size — our own calls are never history.
    const f = writeSession('enc', 'p6', {
      prompts: ['You are the memory distiller for a coding agent working on this project.'],
      pad: 300_000,
    });
    expect(probeSession(f).kind).toBe('oneshot');
  });
});

describe('discoverSessions', () => {
  const CWD = 'D:\\work\\demo';
  const ENC = encodeProjectDirVariants(CWD)[0];

  function realSession(id: string, extra: SessionSpec = {}) {
    return writeSession(ENC, id, { cwd: CWD, prompts: ['a', 'b'], titles: [`t-${id}`], pad: 6000, ...extra });
  }

  it('finds this workspace\'s sessions and ignores other projects', () => {
    realSession('mine1');
    realSession('mine2');
    writeSession(encodeProjectDirVariants('D:\\other\\repo')[0], 'theirs', {
      cwd: 'D:\\other\\repo',
      prompts: ['a', 'b'],
      titles: ['t'],
      pad: 6000,
    });

    const r = discoverSessions({ cwd: CWD, env: env() });
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual(['mine1', 'mine2']);
  });

  it('matches a directory whose NAME does not encode our path, by reading cwd', () => {
    // The encoder changed between CLI versions, so the folder name can be
    // anything — the cwd inside the file is what counts.
    writeSession('totally-unrelated-folder-name', 'odd', {
      cwd: CWD,
      prompts: ['a', 'b'],
      titles: ['t'],
      pad: 6000,
    });
    const r = discoverSessions({ cwd: CWD, env: env() });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['odd']);
  });

  it('never enumerates the subagents/ sidecar directory', () => {
    realSession('parent');
    const side = path.join(projects, ENC, 'parent', 'subagents');
    fs.mkdirSync(side, { recursive: true });
    fs.writeFileSync(
      path.join(side, 'agent-abc.jsonl'),
      JSON.stringify({ type: 'user', cwd: CWD, isSidechain: true, message: { role: 'user', content: 'x'.repeat(5000) } }),
    );
    const r = discoverSessions({ cwd: CWD, env: env() });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['parent']);
  });

  it('skips one-shots, short files and live sessions, and counts each', () => {
    realSession('good');
    realSession('oneshot', { prompts: ['You are the memory curator for a coding agent.'], titles: [] });
    writeSession(ENC, 'tiny', { cwd: CWD, prompts: ['hi'], titles: ['t'], pad: 0 });
    realSession('running');

    const r = discoverSessions({
      cwd: CWD,
      env: { ...env(), CLAUDE_CODE_SESSION_ID: 'running' } as NodeJS.ProcessEnv,
    });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['good']);
    expect(r.skipped.oneshot).toBe(1);
    expect(r.skipped.short).toBe(1);
    expect(r.skipped.live).toBe(1);
  });

  it('honours the ledger\'s already-imported set', () => {
    realSession('a');
    realSession('b');
    const r = discoverSessions({ cwd: CWD, env: env(), skipSessionIds: new Set(['a']) });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(r.skipped.alreadyImported).toBe(1);
  });

  it('returns newest first and respects the limit', () => {
    const files = ['old', 'mid', 'new'].map((id) => realSession(id));
    const base = Date.now();
    files.forEach((f, i) => fs.utimesSync(f, new Date(base), new Date(base + i * 60_000)));
    const r = discoverSessions({ cwd: CWD, env: env(), limit: 2 });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['new', 'mid']);
  });

  it('drops sessions older than --since', () => {
    const f = realSession('ancient');
    const old = Date.now() - 90 * 86_400_000;
    fs.utimesSync(f, new Date(old), new Date(old));
    realSession('recent');
    const r = discoverSessions({ cwd: CWD, env: env(), sinceMs: Date.now() - 7 * 86_400_000 });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['recent']);
    expect(r.skipped.old).toBe(1);
  });

  it('--all sweeps every project and reports the per-project breakdown', () => {
    realSession('mine');
    writeSession(encodeProjectDirVariants('D:\\other\\repo')[0], 'theirs1', {
      cwd: 'D:\\other\\repo', prompts: ['a', 'b'], titles: ['t'], pad: 6000,
    });
    writeSession(encodeProjectDirVariants('D:\\other\\repo')[0], 'theirs2', {
      cwd: 'D:\\other\\repo', prompts: ['a', 'b'], titles: ['t'], pad: 6000,
    });
    const r = discoverSessions({ cwd: CWD, all: true, env: env() });
    expect(r.sessions).toHaveLength(3);
    expect(r.byProject[0]).toEqual({ cwd: 'D:\\other\\repo', count: 2 });
  });

  it('tolerates a project dir holding no transcripts at all', () => {
    fs.mkdirSync(path.join(projects, 'empty-dir'), { recursive: true });
    realSession('mine');
    const cache: Record<string, string | null> = {};
    const r = discoverSessions({ cwd: CWD, env: env(), dirCwdCache: cache });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['mine']);
    // Cached as "nothing here" so it is never probed again.
    expect(cache['empty-dir']).toBeNull();
  });

  it('returns an empty result when there is no history at all', () => {
    const r = discoverSessions({ cwd: CWD, env: { NFF_BRAIN_CLAUDE_HOME: path.join(home, 'gone') } as NodeJS.ProcessEnv });
    expect(r.sessions).toEqual([]);
  });
});

describe('liveSessionIds', () => {
  it('reads the session registry and includes the current session', () => {
    const dir = path.join(home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ sessionId: 'busy-one', status: 'busy' }));
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ sessionId: 'done-one', status: 'exited' }));
    fs.writeFileSync(path.join(dir, '3.json'), 'half-written{');

    const live = liveSessionIds({ ...env(), CLAUDE_CODE_SESSION_ID: 'self' } as NodeJS.ProcessEnv);
    expect(live.has('busy-one')).toBe(true);
    expect(live.has('self')).toBe(true);
    expect(live.has('done-one')).toBe(false);
  });
});

describe('promptCountForPath', () => {
  it('counts history.jsonl entries for a path, to explain an empty scan', () => {
    fs.writeFileSync(
      path.join(home, 'history.jsonl'),
      [
        JSON.stringify({ display: 'a', project: 'D:\\work\\demo', timestamp: 1 }),
        JSON.stringify({ display: 'b', project: 'D:/work/demo/', timestamp: 2 }),
        JSON.stringify({ display: 'c', project: 'D:\\elsewhere', timestamp: 3 }),
        'garbage',
      ].join('\n'),
    );
    expect(promptCountForPath('D:\\work\\demo', env())).toBe(2);
    expect(promptCountForPath('D:\\nothing', env())).toBe(0);
  });
});
