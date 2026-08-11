import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_MAX_NEW_NODES,
  PENDING_FILE,
  PREVIEW_FILE,
  ageDaysOf,
  applyImport,
  brainLogPath,
  buildImportPrompt,
  clusterProposals,
  discoverSessions,
  firstUserText,
  hasCorrection,
  loadBrain,
  loadImportState,
  mapPool,
  mutateBrain,
  parseImportResponse,
  promptCountForPath,
  pruneBrain,
  readTranscriptWindow,
  recordProposalHashes,
  recordSession,
  reconcileWithBrain,
  renderImportPreview,
  resolveBrainPaths,
  resolvePreview,
  runClaude,
  saveImportState,
  seenProposalHashes,
  skippableSessionIds,
  appendActivity,
  type PendingFile,
  type PendingItem,
  type Proposal,
  type SessionMeta,
} from '@nff-brain/core';
import { flagNum, flagStr, parseArgs, type Args } from '../util.js';

// `nff-brain import` — mine past Claude Code sessions into the brain.
//
// Two phases, deliberately separated by a file the human reads:
//   import          scan → one claude -p per session → cluster → PREVIEW ONLY
//   import --apply  commit the items still checked in that preview
//
// Nothing touches brain.json in phase one. Writing thirty machine-proposed
// nodes into a brain the user has never seen is the surprise that gets a tool
// uninstalled; the preview IS the trust-building moment.

const DEFAULT_LIMIT = 40;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_PER_KIND = 4;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MIN_TRANSCRIPT_CHARS = 2_000; // import's bar is far above distill's 200
// Import windows are a full 12 KB, unlike distill's tail-capped ones, so they
// get longer than runClaude's 60 s default — but an explicit env override still
// wins, which is what lets the e2e suite exercise the hang path quickly.
const IMPORT_TIMEOUT_MS = 90_000;
function importTimeoutMs(): number {
  return Number(process.env.NFF_BRAIN_TIMEOUT_MS) || IMPORT_TIMEOUT_MS;
}
const MAX_TOTAL_NODES = 400;
const STALE_PREVIEW_DAYS = 14;

/** `7d` / `48h` / `3w` / an ISO date → epoch ms, or null when unparseable. */
export function parseSince(value: string, now = new Date()): number | null {
  const rel = value.trim().match(/^(\d+)\s*([dhw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'h' ? 3_600_000 : unit === 'w' ? 7 * 86_400_000 : 86_400_000;
    return now.getTime() - n * ms;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function note(line = ''): void {
  // Progress goes to stderr so stdout stays pipe-able.
  process.stderr.write(`${line}\n`);
}

function label(s: SessionMeta): string {
  return s.title ?? s.firstPrompt.slice(0, 48) ?? s.sessionId.slice(0, 8);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export async function cmdImport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.apply === true) return applyPhase(args);
  return scanPhase(args);
}

async function scanPhase(args: Args): Promise<void> {
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const minConfidence = flagNum(args, 'min-confidence') ?? DEFAULT_MIN_CONFIDENCE;
  const limit = flagNum(args, 'limit') ?? DEFAULT_LIMIT;
  const concurrency = Math.min(8, Math.max(1, flagNum(args, 'concurrency') ?? DEFAULT_CONCURRENCY));
  const force = args.flags.force === true;
  const all = args.flags.all === true;
  const project = flagStr(args, 'project');

  const sinceRaw = flagStr(args, 'since');
  let sinceMs: number | null = null;
  if (sinceRaw) {
    sinceMs = parseSince(sinceRaw);
    if (sinceMs === null) throw new Error(`could not read --since "${sinceRaw}" — try 7d, 48h, 3w or 2026-07-01`);
  }

  // An unreviewed preview may carry hand-edits and unticked boxes; silently
  // regenerating over it would throw that work away.
  const existingPreview = brainLogPath(target, PREVIEW_FILE);
  if (!force && args.flags.yes !== true && fs.existsSync(existingPreview)) {
    note('  apply it        nff-brain import --apply');
    note('  or discard it   nff-brain import --force');
    // Throw rather than set process.exitCode: index.ts always calls
    // flushExit(0) on a resolved command, so only a rejection exits non-zero.
    throw new Error(`a preview is already waiting at ${existingPreview}`);
  }

  const state = loadImportState(target);

  note('scanning Claude Code history…');
  const found = discoverSessions({
    cwd: paths.workspaceRoot,
    project,
    all,
    limit,
    sinceMs,
    skipSessionIds: force ? undefined : skippableSessionIds(state),
    dirCwdCache: state.dirCwd,
  });

  const scope = project ?? (all ? 'ALL projects' : paths.workspaceRoot);
  note(`  ${found.scanned.dirs} project folders, ${found.scanned.files} transcripts on disk`);

  if (!found.sessions.length) {
    reportEmptyScan(found, state, paths.workspaceRoot, all);
    return;
  }

  if (all) {
    note(`  spanning ${found.byProject.length} projects:`);
    for (const p of found.byProject.slice(0, 8)) note(`    ${String(p.count).padStart(4)}  ${p.cwd}`);
    if (found.byProject.length > 8) note(`    …and ${found.byProject.length - 8} more`);
    // Transcripts hold secrets, absolute paths and other clients' code, and
    // each session ships ~12 KB of itself to claude -p. Sweeping every project
    // is a much wider disclosure than the current one, so make it deliberate.
    if (args.flags.yes !== true) {
      note('');
      note('  --all sends transcripts from EVERY project to claude -p.');
      note('  Re-run with --yes to confirm.');
      return;
    }
  }

  const skipNote = [
    found.skipped.oneshot ? `${found.skipped.oneshot} one-shot` : '',
    found.skipped.short ? `${found.skipped.short} too short` : '',
    found.skipped.live ? `${found.skipped.live} in progress` : '',
    found.skipped.alreadyImported ? `${found.skipped.alreadyImported} already imported` : '',
    found.skipped.old ? `${found.skipped.old} older than --since` : '',
  ].filter(Boolean);
  note(`  ${found.sessions.length} selected (newest first)${skipNote.length ? ` · skipped ${skipNote.join(', ')}` : ''}`);
  note(`  ~${found.sessions.length} claude -p calls, ${concurrency} at a time — roughly ${estimateMinutes(found.sessions.length, concurrency)}`);
  note('');

  const snapshot = loadBrain(target);
  const knownNodes = snapshot?.nodes ?? [];
  const model = flagStr(args, 'model');
  const started = Date.now();
  let failures = 0;

  const results = await mapPool(
    found.sessions,
    concurrency,
    async (session): Promise<Proposal[]> => {
      const transcript = readTranscriptWindow(session.file);
      if (transcript.length < MIN_TRANSCRIPT_CHARS) return [];
      const prompt = buildImportPrompt({
        taskText: session.firstPrompt || label(session),
        transcript,
        knownNodes,
        maxPerKind: MAX_PER_KIND,
        maxTranscriptChars: MAX_TRANSCRIPT_CHARS,
        sessionLabel: label(session),
      });
      const raw = await runClaude(prompt, { model, timeoutMs: importTimeoutMs() });
      return parseImportResponse(raw, {
        session: { sessionId: session.sessionId, title: session.title, date: session.endedAt },
        transcriptChars: transcript.length,
        hasCorrection: hasCorrection(transcript),
        ageDays: ageDaysOf(session.endedAt),
        maxPerKind: MAX_PER_KIND,
      });
    },
    (done, total, r) => {
      const s = r.item;
      if (r.error) {
        failures += 1;
        note(`  ✗ ${label(s).padEnd(38).slice(0, 38)}  ${r.error instanceof Error ? r.error.message : 'failed'}`);
      } else if (r.value?.length) {
        note(`  ✓ ${label(s).padEnd(38).slice(0, 38)}  ${r.value.length} found   [${done}/${total}]`);
      } else {
        note(`  · ${label(s).padEnd(38).slice(0, 38)}  nothing durable   [${done}/${total}]`);
      }
    },
  );

  const proposals = results.flatMap((r) => r.value ?? []);
  note('');
  if (!proposals.length) {
    note(`nothing durable found in ${found.sessions.length} session(s) after ${fmtDuration(Date.now() - started)}.`);
    if (failures) note(`${failures} session(s) failed — re-run to retry them.`);
    return;
  }

  const clusters = clusterProposals(proposals);
  const brain = snapshot ?? loadBrain(target);
  const items = reconcileWithBrain(brain ?? { version: 1, updatedAt: '', nodes: [], edges: [] }, clusters, {
    minConfidence,
    seenHashes: force ? undefined : seenProposalHashes(state),
  });

  const byKind = new Map<string, number>();
  for (const i of items) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  note(`${proposals.length} proposals → ${items.length} after merging duplicates across sessions`);
  note(`  ${[...byKind].map(([k, n]) => `${n} ${k}`).join(' · ')}`);

  const createdAt = new Date().toISOString();
  const pending: PendingFile = {
    version: 1,
    createdAt,
    workspaceRoot: paths.workspaceRoot,
    brainPath: target,
    brainUpdatedAt: brain?.updatedAt ?? '',
    minConfidence,
    sessionsRead: found.sessions.map((s) => s.sessionId),
    sessionBytes: Object.fromEntries(found.sessions.map((s) => [s.sessionId, s.bytes])),
    items,
  };

  const previewPath = brainLogPath(target, PREVIEW_FILE);
  const pendingPath = brainLogPath(target, PENDING_FILE);
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(
    previewPath,
    renderImportPreview(items, {
      brainPath: target,
      sessionCount: found.sessions.length,
      createdAt,
      minConfidence,
    }),
    'utf8',
  );
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');

  // Discovery cache only — the sessions are NOT marked imported until --apply,
  // so an abandoned preview leaves the next run free to re-read them.
  state.dirCwd = { ...state.dirCwd };
  saveImportState(target, state);

  const checked = items.filter((i) => i.checked).length;
  note('');
  if (failures) note(`${failures} session(s) failed and were skipped.`);
  console.log(`wrote ${previewPath}   (${checked} checked, ${items.length - checked} unchecked)`);
  console.log('');
  console.log('  1. open it — uncheck anything you don\'t want, edit freely');
  console.log('  2. nff-brain import --apply');

  if (args.flags.yes === true && !all) await applyPhase(args);
}

function estimateMinutes(sessions: number, concurrency: number): string {
  const seconds = Math.ceil((sessions / concurrency) * 25);
  if (seconds < 90) return `${seconds}s`;
  return `about ${Math.max(1, Math.round(seconds / 60))} minute${seconds >= 90 ? 's' : ''}`;
}

function reportEmptyScan(
  found: ReturnType<typeof discoverSessions>,
  _state: ReturnType<typeof loadImportState>,
  workspaceRoot: string,
  all: boolean,
): void {
  // Order matters: a folder routinely has BOTH already-mined sessions and
  // one-shots, and "no new sessions" is the more useful of the two answers.
  if (found.skipped.alreadyImported) {
    console.log(`no new sessions since the last import (${found.skipped.alreadyImported} already mined).`);
    console.log('use --force to re-scan them.');
    return;
  }
  if (found.skipped.oneshot) {
    // The nff-brain repo itself hits this: its project folder holds only the
    // `claude -p` calls nff-brain made, never a human session.
    console.log(`the only transcripts for this folder are ${found.skipped.oneshot} one-shot \`claude -p\` run(s) — nothing to import.`);
    return;
  }
  if (found.scanned.dirs === 0) {
    console.log(`no Claude Code history at ${found.projectsDir}`);
    console.log('set NFF_BRAIN_CLAUDE_HOME if your config lives elsewhere.');
    return;
  }
  const prompts = all ? 0 : promptCountForPath(workspaceRoot);
  if (prompts > 0) {
    console.log(`no transcripts for ${workspaceRoot}, though history.jsonl remembers ${prompts} prompt(s) here —`);
    console.log('your transcripts may have been cleared.');
    return;
  }
  console.log(`no past sessions found for ${workspaceRoot}.`);
  console.log('try --all to sweep every project, or --project <path>.');
}

async function applyPhase(args: Args): Promise<void> {
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const previewPath = brainLogPath(target, PREVIEW_FILE);
  const pendingPath = brainLogPath(target, PENDING_FILE);
  const force = args.flags.force === true;

  let pending: PendingFile;
  let md: string;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as PendingFile;
    md = fs.readFileSync(previewPath, 'utf8');
  } catch {
    throw new Error(`no import preview at ${previewPath} — run \`nff-brain import\` first`);
  }

  if (!force) {
    const ageDays = ageDaysOf(pending.createdAt);
    if (ageDays > STALE_PREVIEW_DAYS) {
      note(`note: this preview is ${ageDays} days old — re-run \`nff-brain import\` to pick up newer sessions.`);
    }
    const current = loadBrain(target);
    if (current && pending.brainUpdatedAt && current.updatedAt !== pending.brainUpdatedAt) {
      note('note: the brain changed since this preview was written — reconciling against it now.');
    }
  }

  const { accepted, rejected, warnings } = resolvePreview(pending, md);
  for (const w of warnings) note(`warning: ${w}`);

  if (!accepted.length) {
    console.log(`nothing checked in ${previewPath} — brain unchanged (${rejected} item(s) declined).`);
    return;
  }

  note(`applying ${accepted.length} checked item(s) from ${previewPath}`);

  const maxNew = flagNum(args, 'max-new') ?? DEFAULT_MAX_NEW_NODES;
  const before = loadBrain(target)?.nodes.length ?? 0;
  let result!: ReturnType<typeof applyImport>;

  mutateBrain(target, (brain) => {
    result = applyImport(brain, accepted as PendingItem[], { maxNewNodes: maxNew });
    pruneBrain(brain, MAX_TOTAL_NODES);
  });

  // Ledger and preview bookkeeping happen after the brain write so a failed
  // write never marks the work as done.
  const state = loadImportState(target);
  const committed = new Set([...result.created, ...result.refined]);
  recordProposalHashes(
    state,
    accepted.filter((i) => committed.has(i.id)).map((i) => i.hash),
  );
  for (const sessionId of pending.sessionsRead) {
    if (state.sessions[sessionId]) continue;
    // Record the size we mined at, so a session that is later RESUMED and grows
    // is offered again rather than written off forever.
    recordSession(state, sessionId, {
      bytes: pending.sessionBytes?.[sessionId] ?? 0,
      mtimeMs: 0,
      produced: accepted.filter((i) => i.sources.some((s) => s.sessionId === sessionId)).map((i) => i.id),
    });
  }
  state.lastRunAt = new Date().toISOString();
  saveImportState(target, state);

  try {
    appendActivity(path.dirname(paths.project), { kind: 'distill', ids: [...committed] });
  } catch {
    /* the glow is cosmetic — never fail an import over it */
  }

  const after = loadBrain(target)?.nodes.length ?? 0;
  console.log(`  created ${result.created.length} · refined ${result.refined.length} · ${result.edges} edge(s)`);
  if (result.skipped.length) {
    const capped = result.skipped.filter((s) => s.reason === 'cap');
    if (capped.length) {
      console.log(`  ${capped.length} item(s) over the --max-new ${maxNew} cap were left for a second \`--apply\`.`);
    }
  }
  const edited = accepted.filter((i) => i.edited);
  for (const i of edited) console.log(`  edited: ${i.id} ← "${i.title}"`);
  console.log('');
  console.log(`your brain now knows ${after} things (was ${before}).`);
  console.log(`try:  nff-brain recall --query "${accepted[0].title.split(' ').slice(0, 4).join(' ')}"`);

  // The preview has been consumed; leaving it would invite a double-apply.
  if (!result.skipped.some((s) => s.reason === 'cap')) {
    try {
      fs.rmSync(previewPath, { force: true });
      fs.rmSync(pendingPath, { force: true });
    } catch {
      /* leaving them is harmless — --apply is idempotent */
    }
  }
}
