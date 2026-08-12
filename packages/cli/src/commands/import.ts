import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_MAX_NEW_NODES,
  PENDING_FILE,
  PREVIEW_FILE,
  ageDaysOf,
  applyImport,
  brainLogPath,
  loadBrain,
  loadImportState,
  mutateBrain,
  promptCountForPath,
  pruneBrain,
  recordProposalHashes,
  recordSession,
  resolveBrainPaths,
  resolvePreview,
  saveImportState,
  appendActivity,
  type PendingFile,
  type PendingItem,
} from '@nff-brain/core';
import { flagNum, parseArgs, type Args } from '../util.js';
import { estimateMinutes, planFromArgs, shouldRunWizard } from './importPlan.js';
import {
  classifyEmptyScan,
  discoverForPlan,
  emptyScanLines,
  extractProposals,
  fmtDuration,
  label,
  reconcileProposals,
  writePreviewArtifacts,
} from './importEngine.js';

// `nff-brain import` — mine past Claude Code sessions into the brain.
//
// Three entry shapes:
//   import                 (bare, in a TTY) → the interactive wizard
//   import [--flags…]      scan → one claude -p per session → cluster → PREVIEW ONLY
//   import --apply         commit the items still checked in that preview
//
// Nothing touches brain.json before a review. Writing thirty machine-proposed
// nodes into a brain the user has never seen is the surprise that gets a tool
// uninstalled; the review IS the trust-building moment.

// Re-exported for importArgs.test.ts and any external callers.
export { parseSince } from './importPlan.js';

const MAX_TOTAL_NODES = 400;
export const STALE_PREVIEW_DAYS = 14;

function note(line = ''): void {
  // Progress goes to stderr so stdout stays pipe-able.
  process.stderr.write(`${line}\n`);
}

export async function cmdImport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.apply === true) return applyPhase(args);
  if (
    shouldRunWizard({
      args,
      stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true,
      stderrTTY: process.stderr.isTTY === true,
      env: process.env,
    })
  ) {
    // Lazy: the hook/classic paths must never load the TUI code.
    const { runImportWizard } = await import('./importWizard.js');
    return runImportWizard(args);
  }
  return scanPhase(args);
}

async function scanPhase(args: Args): Promise<void> {
  const plan = planFromArgs(args);
  const { paths, target } = plan;

  // An unreviewed preview may carry hand-edits and unticked boxes; silently
  // regenerating over it would throw that work away.
  const existingPreview = brainLogPath(target, PREVIEW_FILE);
  if (!plan.force && !plan.yes && fs.existsSync(existingPreview)) {
    note('  apply it        nff-brain import --apply');
    note('  or discard it   nff-brain import --force');
    // Throw rather than set process.exitCode: index.ts always calls
    // flushExit(0) on a resolved command, so only a rejection exits non-zero.
    throw new Error(`a preview is already waiting at ${existingPreview}`);
  }

  const state = loadImportState(target);

  note('scanning Claude Code history…');
  const found = discoverForPlan(plan, state);

  note(`  ${found.scanned.dirs} project folders, ${found.scanned.files} transcripts on disk`);

  if (!found.sessions.length) {
    const prompts = plan.all ? 0 : promptCountForPath(paths.workspaceRoot);
    for (const line of emptyScanLines(classifyEmptyScan(found, paths.workspaceRoot, prompts))) console.log(line);
    return;
  }

  if (plan.all) {
    note(`  spanning ${found.byProject.length} projects:`);
    for (const p of found.byProject.slice(0, 8)) note(`    ${String(p.count).padStart(4)}  ${p.cwd}`);
    if (found.byProject.length > 8) note(`    …and ${found.byProject.length - 8} more`);
    // Transcripts hold secrets, absolute paths and other clients' code, and
    // each session ships ~12 KB of itself to claude -p. Sweeping every project
    // is a much wider disclosure than the current one, so make it deliberate.
    if (!plan.yes) {
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
  note(`  ~${found.sessions.length} claude -p calls, ${plan.concurrency} at a time — roughly ${estimateMinutes(found.sessions.length, plan.concurrency)}`);
  note('');

  const snapshot = loadBrain(target);
  const started = Date.now();

  const { proposals, failures } = await extractProposals(found.sessions, plan, snapshot?.nodes ?? [], (done, total, r) => {
    const s = r.item;
    if (r.error) {
      note(`  ✗ ${label(s).padEnd(38).slice(0, 38)}  ${r.error instanceof Error ? r.error.message : 'failed'}`);
    } else if (r.value?.length) {
      note(`  ✓ ${label(s).padEnd(38).slice(0, 38)}  ${r.value.length} found   [${done}/${total}]`);
    } else {
      note(`  · ${label(s).padEnd(38).slice(0, 38)}  nothing durable   [${done}/${total}]`);
    }
  });

  note('');
  if (!proposals.length) {
    note(`nothing durable found in ${found.sessions.length} session(s) after ${fmtDuration(Date.now() - started)}.`);
    if (failures) note(`${failures} session(s) failed — re-run to retry them.`);
    return;
  }

  const brain = snapshot ?? loadBrain(target);
  const items = reconcileProposals(proposals, plan, brain, state);

  const byKind = new Map<string, number>();
  for (const i of items) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  note(`${proposals.length} proposals → ${items.length} after merging duplicates across sessions`);
  note(`  ${[...byKind].map(([k, n]) => `${n} ${k}`).join(' · ')}`);

  const { previewPath } = writePreviewArtifacts(items, plan, found, brain, state);

  const checked = items.filter((i) => i.checked).length;
  note('');
  if (failures) note(`${failures} session(s) failed and were skipped.`);
  console.log(`wrote ${previewPath}   (${checked} checked, ${items.length - checked} unchecked)`);
  console.log('');
  console.log('  1. open it — uncheck anything you don\'t want, edit freely');
  console.log('  2. nff-brain import --apply');

  if (plan.yes && !plan.all) await applyPhase(args);
}

export async function applyPhase(args: Args): Promise<void> {
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
