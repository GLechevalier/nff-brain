// Discovery over Claude Code's own session history (~/.claude/projects).
//
// Claude Code stores one JSONL transcript per session, filed under a directory
// named after the session's cwd with every non-alphanumeric character replaced
// by '-'. Three things about that layout drive the design here, all verified
// against a real 1500-session install:
//
//   1. THE ENCODER IS NOT STABLE ACROSS CLI VERSIONS. Both `…-R-D-MCPIOT-…`
//      and `…-R_D-MCPIOT-…` exist side by side for the same path. Encoding is
//      therefore only ever a fast path; the truth is the `cwd` field inside the
//      file, and a directory whose name doesn't match may still be ours.
//   2. `cwd` IS NOT ON THE FIRST RECORD. The first line is usually a
//      `queue-operation` / `last-prompt` / `mode` state record. Scan forward.
//   3. FILES ARE BIG (up to ~6 MB) AND NUMEROUS. Reading 244 of them whole
//      costs 711 ms / 222 MB; bounded head+tail windows cost 52 ms flat. The
//      title we want lives within 88 KB of the head or 33 KB of the tail, so
//      the windows below cover it with room to spare.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isNffPrompt } from './promptMarkers.js';
import { readFileEnds } from './transcript.js';

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;

/** Root of the Claude Code config dir. `NFF_BRAIN_CLAUDE_HOME` is for tests. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NFF_BRAIN_CLAUDE_HOME ||
    env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude')
  );
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeHome(env), 'projects');
}

/**
 * Directory-name encodings a given cwd may appear under. The first is the
 * current scheme; the second preserves underscores, which older CLI versions
 * did. Never treat these as authoritative — see note 1 above.
 */
export function encodeProjectDirVariants(cwd: string): string[] {
  const abs = path.resolve(cwd);
  const current = abs.replace(/[^A-Za-z0-9]/g, '-');
  const legacy = abs.replace(/[^A-Za-z0-9_]/g, '-');
  return current === legacy ? [current] : [current, legacy];
}

/** Compare two filesystem paths for identity (case-insensitively on Windows). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let s = path.resolve(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}

export interface SessionMeta {
  sessionId: string; // file basename minus .jsonl
  file: string; // absolute path
  projectDir: string; // the ~/.claude/projects/<encoded> dir it lives in
  cwd: string | null; // REAL cwd, read out of the file
  title: string | null; // LAST ai-title in the file — the human label
  firstPrompt: string; // first typed user message, ≤ 300 chars
  startedAt: string | null; // ISO
  endedAt: string | null; // ISO
  bytes: number;
  mtimeMs: number;
  userTurns: number; // counted within the probe windows — a LOWER BOUND
  version: string | null; // Claude Code CLI version
  gitBranch: string | null;
  isSidechain: boolean;
  // 'oneshot' = a `claude -p` invocation, not a human session. nff-brain's own
  // LLM calls land here too, so importing these would feed the brain its own
  // prompts back.
  kind: 'interactive' | 'oneshot';
}

interface AnyRecord {
  type?: unknown;
  cwd?: unknown;
  version?: unknown;
  gitBranch?: unknown;
  timestamp?: unknown;
  aiTitle?: unknown;
  isSidechain?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Read a session's metadata from bounded windows at both ends of the file.
 *
 * Everything here is best-effort: a truncated, half-written or foreign JSONL
 * file must yield a usable (if sparse) SessionMeta rather than throw, because
 * one bad file among hundreds cannot be allowed to fail a scan.
 */
export function probeSession(
  file: string,
  opts: { headBytes?: number; tailBytes?: number; stat?: fs.Stats } = {},
): SessionMeta {
  const sessionId = path.basename(file).replace(/\.jsonl$/i, '');
  const meta: SessionMeta = {
    sessionId,
    file,
    projectDir: path.dirname(file),
    cwd: null,
    title: null,
    firstPrompt: '',
    startedAt: null,
    endedAt: null,
    bytes: 0,
    mtimeMs: 0,
    userTurns: 0,
    version: null,
    gitBranch: null,
    isSidechain: false,
    kind: 'interactive',
  };

  try {
    const st = opts.stat ?? fs.statSync(file);
    meta.bytes = st.size;
    meta.mtimeMs = st.mtimeMs;
  } catch {
    return meta;
  }

  const ends = readFileEnds(file, opts.headBytes ?? HEAD_BYTES, opts.tailBytes ?? TAIL_BYTES);
  if (!ends) return meta;

  // Head then tail: file order, so "last one wins" fields resolve correctly.
  for (const line of [...ends.head, ...ends.tail]) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let r: AnyRecord;
    try {
      r = JSON.parse(t) as AnyRecord;
    } catch {
      continue;
    }

    if (!meta.cwd) meta.cwd = str(r.cwd);
    if (!meta.version) meta.version = str(r.version);
    if (!meta.gitBranch) meta.gitBranch = str(r.gitBranch);
    if (r.isSidechain === true) meta.isSidechain = true;

    const ts = str(r.timestamp);
    if (ts) {
      if (!meta.startedAt) meta.startedAt = ts;
      meta.endedAt = ts;
    }

    // The title is rewritten as a session evolves — the LAST one is the good one.
    if (r.type === 'ai-title') {
      const t2 = str(r.aiTitle);
      if (t2) meta.title = t2;
    }

    const role = r.message?.role ?? r.type;
    if (role === 'user') {
      // A typed prompt has a bare STRING content; tool results are arrays.
      const content = r.message?.content;
      if (typeof content === 'string') {
        const text = content.trim();
        if (text && !text.startsWith('<')) {
          meta.userTurns += 1;
          if (!meta.firstPrompt) meta.firstPrompt = text.slice(0, 300);
        }
      }
    }
  }

  meta.kind = classifySession(meta);
  return meta;
}

/**
 * A transcript this big is a worked session whatever its turn count looks like.
 * The largest prompt nff-brain sends is a 12 KB transcript plus the node list,
 * so its `claude -p` transcripts land in the tens of KB.
 */
const ONESHOT_MAX_BYTES = 200 * 1024;

/**
 * A `claude -p` one-shot vs a real interactive session.
 *
 * Note the first-record type is NOT a usable discriminator: real sessions also
 * open with `queue-operation`. What separates them is that a one-shot has a
 * single user turn and never earns an ai-title.
 *
 * `userTurns` is only a LOWER BOUND — it counts turns inside the probe windows,
 * and a 1 MB session has most of its middle unread, so it routinely probes as
 * `turns=1`. The size guard below stops that undercount from throwing away real
 * history: without it, any large session that never earned a title would be
 * misread as a one-shot and silently skipped.
 */
export function classifySession(meta: SessionMeta): 'interactive' | 'oneshot' {
  if (isNffPrompt(meta.firstPrompt)) return 'oneshot'; // ours, whatever its size
  if (meta.bytes > ONESHOT_MAX_BYTES) return 'interactive';
  if (meta.userTurns <= 1 && !meta.title) return 'oneshot';
  return 'interactive';
}

/** Session ids that are still running, and so still being appended to. */
export function liveSessionIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const live = new Set<string>();
  const self = env.CLAUDE_CODE_SESSION_ID;
  if (self) live.add(self); // the session running this very command
  const dir = path.join(claudeHome(env), 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
        sessionId?: unknown;
        status?: unknown;
      };
      const id = str(r.sessionId);
      if (id && r.status !== 'exited') live.add(id);
    } catch {
      // a half-written registry file tells us nothing; skip it
    }
  }
  return live;
}

export interface DiscoverOptions {
  cwd?: string; // workspace to match; defaults to process.cwd()
  all?: boolean; // every project dir, not just this workspace
  project?: string; // an explicit different workspace
  limit?: number; // cap on returned sessions (default 40)
  sinceMs?: number | null; // drop sessions older than this epoch ms
  minBytes?: number; // drop trivially small transcripts (default 4096)
  includeOneShots?: boolean;
  includeSidechains?: boolean;
  includeLive?: boolean;
  skipSessionIds?: ReadonlySet<string>; // the ledger's already-imported set
  // Encoded-dir → real cwd cache, read AND written. Persisting this across runs
  // turns the 27-directory probe into zero I/O.
  dirCwdCache?: Record<string, string | null>;
  env?: NodeJS.ProcessEnv;
}

export interface DiscoverResult {
  sessions: SessionMeta[];
  scanned: { dirs: number; files: number };
  skipped: {
    oneshot: number;
    short: number;
    live: number;
    sidechain: number;
    old: number;
    alreadyImported: number;
  };
  byProject: Array<{ cwd: string; count: number }>; // for --all's confirmation
  projectsDir: string;
}

function listJsonl(dir: string): Array<{ file: string; stat: fs.Stats }> {
  const out: Array<{ file: string; stat: fs.Stats }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // isFile() alone skips the `<sessionId>/` sidecar dirs, and with them the
    // `subagents/*.jsonl` sidechains — those are fragments of a parent session
    // and would double-count its content.
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.jsonl')) continue;
    const file = path.join(dir, e.name);
    try {
      out.push({ file, stat: fs.statSync(file) });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** Resolve a project directory to the real cwd its sessions ran in. */
function resolveDirCwd(
  dir: string,
  files: Array<{ file: string; stat: fs.Stats }>,
  cache: Record<string, string | null>,
): string | null {
  const key = path.basename(dir);
  if (key in cache) return cache[key];
  if (!files.length) {
    cache[key] = null; // no transcripts — never probe this dir again
    return null;
  }
  const newest = files.reduce((a, b) => (b.stat.mtimeMs > a.stat.mtimeMs ? b : a));
  const cwd = probeSession(newest.file, { stat: newest.stat }).cwd;
  cache[key] = cwd;
  return cwd;
}

export function discoverSessions(opts: DiscoverOptions = {}): DiscoverResult {
  const env = opts.env ?? process.env;
  const projectsDir = claudeProjectsDir(env);
  const limit = Math.max(0, opts.limit ?? 40);
  const minBytes = opts.minBytes ?? 4096;
  const target = path.resolve(opts.project ?? opts.cwd ?? process.cwd());
  const cache = opts.dirCwdCache ?? {};

  const result: DiscoverResult = {
    sessions: [],
    scanned: { dirs: 0, files: 0 },
    skipped: { oneshot: 0, short: 0, live: 0, sidechain: 0, old: 0, alreadyImported: 0 },
    byProject: [],
    projectsDir,
  };

  let dirNames: string[];
  try {
    dirNames = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result; // no history on this machine
  }
  result.scanned.dirs = dirNames.length;

  const wanted = new Set(opts.all ? [] : encodeProjectDirVariants(target));

  // Pick the directories in scope, resolving each to its real cwd.
  const selected: Array<{ dir: string; cwd: string | null; files: Array<{ file: string; stat: fs.Stats }> }> = [];
  for (const name of dirNames) {
    const dir = path.join(projectsDir, name);
    const files = listJsonl(dir);
    result.scanned.files += files.length;
    if (!files.length) {
      // Record it so a later run skips it without a readdir-and-probe. Some
      // project dirs hold only third-party `memory/` output and never any
      // transcript at all.
      cache[name] = null;
      continue;
    }

    if (opts.all) {
      selected.push({ dir, cwd: resolveDirCwd(dir, files, cache), files });
      continue;
    }
    // Fast path: the name encodes our target. Still verified below by cwd when
    // the file carries one, since the encoding is lossy.
    const nameMatches = wanted.has(name);
    const cwd = nameMatches ? (resolveDirCwd(dir, files, cache) ?? target) : resolveDirCwd(dir, files, cache);
    if (nameMatches || (cwd && samePath(cwd, target))) selected.push({ dir, cwd, files });
  }

  // Newest first, then probe only as deep as the caps require.
  const candidates = selected
    .flatMap((s) => s.files.map((f) => ({ ...f, dirCwd: s.cwd })))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const live = opts.includeLive ? new Set<string>() : liveSessionIds(env);
  const byProject = new Map<string, number>();
  // Over-fetch so the filters below cannot starve the cap.
  const probeBudget = limit > 0 ? limit * 3 : candidates.length;
  let probed = 0;

  for (const c of candidates) {
    if (limit > 0 && result.sessions.length >= limit) break;
    if (probed >= probeBudget && limit > 0) break;

    const sessionId = path.basename(c.file).replace(/\.jsonl$/i, '');
    if (opts.skipSessionIds?.has(sessionId)) {
      result.skipped.alreadyImported += 1;
      continue;
    }
    if (c.stat.size < minBytes) {
      result.skipped.short += 1;
      continue;
    }
    if (opts.sinceMs != null && c.stat.mtimeMs < opts.sinceMs) {
      result.skipped.old += 1;
      continue;
    }
    if (!opts.includeLive && live.has(sessionId)) {
      result.skipped.live += 1;
      continue;
    }

    probed += 1;
    const meta = probeSession(c.file, { stat: c.stat });
    if (!meta.cwd && c.dirCwd) meta.cwd = c.dirCwd;

    if (meta.isSidechain && !opts.includeSidechains) {
      result.skipped.sidechain += 1;
      continue;
    }
    if (meta.kind === 'oneshot' && !opts.includeOneShots) {
      result.skipped.oneshot += 1;
      continue;
    }

    result.sessions.push(meta);
    const key = meta.cwd ?? '(unknown)';
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }

  result.byProject = [...byProject].map(([cwd, count]) => ({ cwd, count })).sort((a, b) => b.count - a.count);
  return result;
}

/**
 * How many prompts ~/.claude/history.jsonl remembers for a path.
 *
 * Only ever used to improve the empty state: history.jsonl is a global prompt
 * log with no file paths and no notion of a session ending, so it is useless
 * for enumeration — but when we find no transcripts it can distinguish "you
 * have never worked here" from "your transcripts were cleared".
 */
export function promptCountForPath(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
  const file = path.join(claudeHome(env), 'history.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as { project?: unknown };
      const p = str(r.project);
      if (p && samePath(p, cwd)) n += 1;
    } catch {
      continue;
    }
  }
  return n;
}
