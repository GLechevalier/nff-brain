// The interactive import wizard — what a bare `nff-brain import` opens in a
// real terminal. Scans, asks scope + time range as arrow-key selects, mines
// with live progress, then reviews the findings as an in-terminal checklist
// and applies without a second command.
//
// Ground rules:
//  - all chrome goes to stderr (the note() convention); stdout stays the
//    machine-readable result, which comes from the untouched applyPhase
//  - import-preview.md / import-pending.json are ALWAYS written before the
//    review opens — crash, Esc or Ctrl-C leaves a resumable receipt and
//    `import --apply` keeps working standalone
//  - the apply path is applyPhase + resolvePreview, never a parallel
//    implementation: the wizard re-renders the markdown with the reviewed
//    checkbox state and lets the tested path commit it

import * as fs from 'node:fs';
import {
  PENDING_FILE,
  PREVIEW_FILE,
  SECTION_ORDER,
  SECTION_TITLE,
  ageDaysOf,
  brainLogPath,
  discoverSessions,
  loadBrain,
  loadImportState,
  parseImportPreview,
  promptCountForPath,
  renderImportPreview,
  samePath,
  skippableSessionIds,
  type DiscoverResult,
  type PendingFile,
  type PendingItem,
  type SessionMeta,
} from '@nff-brain/core';
import type { Args } from '../util.js';
import { STALE_PREVIEW_DAYS, applyPhase } from './import.js';
import { estimateMinutes, planFromArgs, parseSince, type ImportPlan } from './importPlan.js';
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
import type { ChecklistResult, ChecklistSection, Glyphs, Option, ProgressHandle, Style } from '../tui/index.js';

// ── the Ui seam — real terminal in production, scripted fake in tests ───────

export interface Spinner {
  stop(final?: string): void;
}

export interface WizardUi {
  style: Style;
  glyphs: Glyphs;
  note(line?: string): void;
  select<T>(question: string, options: Option<T>[]): Promise<T | null>;
  text(question: string, opts?: { placeholder?: string; validate?: (v: string) => string | undefined }): Promise<string | null>;
  checklist(question: string, sections: ChecklistSection[]): Promise<ChecklistResult | null>;
  progress(label: string, total: number): ProgressHandle;
  spinner(label: string): Spinner;
  /** Fires on Esc/Ctrl-C pressed OUTSIDE a widget (i.e. during mining). */
  onCancel(fn: () => void): () => void;
  close(): void;
}

async function createTerminalUi(): Promise<WizardUi> {
  const tui = await import('../tui/index.js');
  const term = tui.createTerm();
  return {
    style: term.style,
    glyphs: term.glyphs,
    note: (line = '') => term.write(`${line}\n`),
    select: (q, o) => tui.select(q, o, { term }),
    text: (q, o) => tui.text(q, { ...o, term }),
    checklist: (q, s) => tui.checklist(q, s, { term }),
    progress: (label, total) => tui.progress({ total, done: 0, active: [] }, { term, label }),
    spinner(label) {
      const frame = tui.createFrame(term, { maxHeight: 1 });
      let tick = 0;
      const paint = (): void =>
        frame.render([`${term.style.accent(term.glyphs.spinner[tick % term.glyphs.spinner.length])} ${label}`]);
      const timer = setInterval(() => {
        tick++;
        paint();
      }, 80);
      timer.unref();
      paint();
      return {
        stop(final) {
          clearInterval(timer);
          frame.close(final !== undefined ? [final] : undefined);
        },
      };
    },
    onCancel: (fn) => term.onKey((k) => {
      if (tui.isCancel(k)) fn();
    }),
    close: () => term.release(),
  };
}

// ── wizard state ────────────────────────────────────────────────────────────

type Step = 'resume' | 'survey' | 'scope' | 'range' | 'confirm' | 'extract' | 'review' | 'apply' | 'done';

interface Wizard {
  plan: ImportPlan;
  state: ReturnType<typeof loadImportState>;
  survey?: DiscoverResult;
  found?: DiscoverResult;
  items?: PendingItem[];
  pending?: PendingFile;
  previewPath: string;
  pendingPath: string;
  interrupted?: string; // banner note for a partial extraction
}

export async function runImportWizard(args: Args, uiIn?: WizardUi): Promise<void> {
  const ui = uiIn ?? (await createTerminalUi());
  try {
    await run(args, ui);
  } finally {
    ui.close();
  }
}

async function run(args: Args, ui: WizardUi): Promise<void> {
  const plan = planFromArgs(args);
  const w: Wizard = {
    plan,
    state: loadImportState(plan.target),
    previewPath: brainLogPath(plan.target, PREVIEW_FILE),
    pendingPath: brainLogPath(plan.target, PENDING_FILE),
  };

  const { style: st, glyphs: g } = ui;
  ui.note(`${st.accent(st.bold('nff-brain import'))} ${st.dim(`${g.dot} mine past Claude Code sessions into your brain`)}`);
  ui.note();

  let step: Step = fs.existsSync(w.previewPath) ? 'resume' : 'survey';

  while (step !== 'done') {
    switch (step) {
      case 'resume':
        step = await stepResume(w, ui);
        break;
      case 'survey':
        step = await stepSurvey(w, ui);
        break;
      case 'scope':
        step = await stepScope(w, ui);
        break;
      case 'range':
        step = await stepRange(w, ui);
        break;
      case 'confirm':
        step = await stepConfirm(w, ui);
        break;
      case 'extract':
        step = await stepExtract(w, ui);
        break;
      case 'review':
        step = await stepReview(w, ui);
        break;
      case 'apply':
        await applyPhase(args);
        step = 'done';
        break;
    }
  }
}

// ── S1b: a preview is already waiting ───────────────────────────────────────

async function stepResume(w: Wizard, ui: WizardUi): Promise<Step> {
  let pending: PendingFile | null = null;
  let md = '';
  try {
    pending = JSON.parse(fs.readFileSync(w.pendingPath, 'utf8')) as PendingFile;
    md = fs.readFileSync(w.previewPath, 'utf8');
  } catch {
    pending = null; // fail-open: a corrupt pending file is just a discardable preview
  }

  if (!pending) {
    const choice = await ui.select<'discard' | 'quit'>('an import preview is waiting but its pending file is unreadable.', [
      { value: 'discard', label: 'Discard it and scan again' },
      { value: 'quit', label: 'Leave it and quit' },
    ]);
    if (choice !== 'discard') return quitWithHints(ui);
    w.plan.force = true;
    return 'survey';
  }

  const age = ageDaysOf(pending.createdAt);
  const ageLabel = age < 1 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
  const checked = pending.items.filter((i) => i.checked).length;
  const stale = age > STALE_PREVIEW_DAYS;

  const review = { value: 'review' as const, label: 'Review and apply it now', hint: `${checked} of ${pending.items.length} checked` };
  const discard = { value: 'discard' as const, label: `Discard it and scan again${stale ? ` (${age} days old)` : ''}` };
  const quit = { value: 'quit' as const, label: 'Leave it and quit' };

  const choice = await ui.select<'review' | 'discard' | 'quit'>(
    `an import preview from ${ageLabel} is waiting — ${pending.items.length} items.`,
    stale ? [discard, review, quit] : [review, discard, quit],
  );

  if (choice === 'review') {
    // Honour hand-edits made in an editor since the preview was written:
    // parsed checkbox/title/body state wins over what pending.json remembers.
    const { edits } = parseImportPreview(md);
    w.pending = pending;
    w.items = pending.items.map((item) => {
      const edit = edits.get(item.key);
      if (!edit) return { ...item, checked: false }; // deleted block = rejected
      return { ...item, checked: edit.checked, title: edit.title || item.title, content: edit.content || item.content };
    });
    return 'review';
  }
  if (choice === 'discard') {
    w.plan.force = true;
    return 'survey';
  }
  return quitWithHints(ui);
}

function quitWithHints(ui: WizardUi): Step {
  ui.note('  apply it        nff-brain import --apply');
  ui.note('  or discard it   nff-brain import --force');
  return 'done';
}

// ── S2/S3: machine-wide survey ──────────────────────────────────────────────

async function stepSurvey(w: Wizard, ui: WizardUi): Promise<Step> {
  const spin = ui.spinner('scanning Claude Code history…');
  // Let the spinner paint one frame before the synchronous walk.
  await new Promise((r) => setImmediate(r));
  const survey = discoverSessions({
    cwd: w.plan.paths.workspaceRoot,
    all: true,
    limit: 0, // uncapped: the scope menu needs exact per-project counts
    skipSessionIds: w.plan.force ? undefined : skippableSessionIds(w.state),
    dirCwdCache: w.state.dirCwd,
  });
  w.survey = survey;
  spin.stop(
    `${ui.style.ok(ui.glyphs.check)} scanned ${survey.scanned.dirs} project folders, ${survey.scanned.files} transcripts ${ui.style.dim(
      `${ui.glyphs.dot} ${survey.sessions.length} sessions look worth mining`,
    )}`,
  );

  if (!survey.sessions.length) {
    const prompts = promptCountForPath(w.plan.paths.workspaceRoot);
    for (const line of emptyScanLines(classifyEmptyScan(survey, w.plan.paths.workspaceRoot, prompts))) ui.note(line);
    return 'done';
  }
  return 'scope';
}

// ── S4: scope ───────────────────────────────────────────────────────────────

async function stepScope(w: Wizard, ui: WizardUi): Promise<Step> {
  const survey = w.survey!;
  const root = w.plan.paths.workspaceRoot;
  const here = survey.byProject.find((p) => samePath(p.cwd, root))?.count ?? 0;
  const total = survey.sessions.length;
  const sessions = (n: number): string => (n === 0 ? '(nothing new)' : `${n} new session${n === 1 ? '' : 's'}`);

  const choice = await ui.select<'this' | 'all' | 'pick' | 'cancel'>('Which sessions should I mine?', [
    { value: 'this', label: 'This project only', hint: sessions(here) },
    { value: 'all', label: 'Every project on this machine', hint: sessions(total) },
    { value: 'pick', label: 'Pick a project…', hint: `${survey.byProject.length} projects` },
    { value: 'cancel', label: 'Cancel' },
  ]);

  if (choice === null || choice === 'cancel') {
    ui.note(ui.style.dim('nothing scanned, nothing written.'));
    return 'done';
  }
  if (choice === 'pick') {
    const picked = await ui.select<string>(
      'Which project?',
      survey.byProject.map((p) => ({ value: p.cwd, label: p.cwd, hint: sessions(p.count) })),
    );
    if (picked === null) return 'scope';
    w.plan.all = false;
    w.plan.project = picked;
    return 'range';
  }
  w.plan.all = choice === 'all';
  w.plan.project = undefined;
  return 'range';
}

// ── S5: time range ──────────────────────────────────────────────────────────

async function stepRange(w: Wizard, ui: WizardUi): Promise<Step> {
  const choice = await ui.select<'7d' | '30d' | 'all' | 'custom' | 'back'>('How far back should I look?', [
    { value: '30d', label: 'The last 30 days' },
    { value: '7d', label: 'The last 7 days' },
    { value: 'all', label: 'Everything', hint: `newest ${w.plan.limit} sessions` },
    { value: 'custom', label: 'Custom…', hint: '7d, 48h, 3w or a date' },
    { value: 'back', label: 'Back' },
  ]);

  if (choice === null || choice === 'back') return 'scope';
  if (choice === 'custom') {
    const raw = await ui.text('Since when?', {
      placeholder: '7d, 48h, 3w or 2026-07-01',
      validate: (v) => (parseSince(v) === null ? `could not read "${v}" — try 7d, 48h, 3w or 2026-07-01` : undefined),
    });
    if (raw === null) return 'range';
    w.plan.sinceRaw = raw;
    w.plan.sinceMs = parseSince(raw);
  } else {
    w.plan.sinceRaw = choice === 'all' ? undefined : choice;
    w.plan.sinceMs = choice === 'all' ? null : parseSince(choice);
  }
  return 'confirm';
}

// ── S6: confirm (with cost estimate and the --all disclosure) ───────────────

async function stepConfirm(w: Wizard, ui: WizardUi): Promise<Step> {
  const { style: st, glyphs: g } = ui;
  const found = discoverForPlan(w.plan, w.state);
  w.found = found;

  if (!found.sessions.length) {
    return stepEmptyScope(w, ui, found);
  }

  const skipNote = [
    found.skipped.oneshot ? `${found.skipped.oneshot} one-shot` : '',
    found.skipped.short ? `${found.skipped.short} too short` : '',
    found.skipped.live ? `${found.skipped.live} in progress` : '',
    found.skipped.alreadyImported ? `${found.skipped.alreadyImported} already imported` : '',
    found.skipped.old ? `${found.skipped.old} outside the range` : '',
  ].filter(Boolean);

  ui.note(`  ${st.bold(String(found.sessions.length))} sessions selected (newest first)${skipNote.length ? st.dim(` ${g.dot} skipped ${skipNote.join(', ')}`) : ''}`);
  if (w.plan.all) {
    ui.note(st.dim(`  spanning ${found.byProject.length} projects`));
    ui.note();
    // Transcripts hold secrets, absolute paths and other clients' code, and
    // each session ships ~12 KB of itself to claude -p. Sweeping every
    // project is a much wider disclosure, so make it deliberate.
    ui.note(`  ${st.warn('⚠')} this sends transcript excerpts from ${st.bold('EVERY project')} to claude -p.`);
  }
  ui.note();

  const choice = await ui.select<'go' | 'back' | 'cancel'>(
    `Mine ${found.sessions.length} sessions? ${w.plan.concurrency} at a time — roughly ${estimateMinutes(found.sessions.length, w.plan.concurrency)}.`,
    [
      { value: 'go', label: 'Start mining', hint: `~${found.sessions.length} claude -p calls` },
      { value: 'back', label: 'Back' },
      { value: 'cancel', label: 'Cancel' },
    ],
  );

  if (choice === 'go') return 'extract';
  if (choice === 'back') return 'range';
  ui.note(ui.style.dim('nothing scanned, nothing written.'));
  return 'done';
}

async function stepEmptyScope(w: Wizard, ui: WizardUi, found: DiscoverResult): Promise<Step> {
  const prompts = w.plan.all ? 0 : promptCountForPath(w.plan.project ?? w.plan.paths.workspaceRoot);
  const reason = classifyEmptyScan(found, w.plan.project ?? w.plan.paths.workspaceRoot, prompts);
  ui.note(emptyScanLines(reason)[0]);
  ui.note();

  const options: Option<'force' | 'scope' | 'range' | 'quit'>[] = [];
  if (reason.kind === 'already-imported') options.push({ value: 'force', label: 'Re-scan them anyway', hint: 'ignores the import ledger' });
  options.push(
    { value: 'scope', label: 'Pick a different scope' },
    { value: 'range', label: 'Widen the time range' },
    { value: 'quit', label: 'Quit' },
  );

  const choice = await ui.select('Nothing new in that scope — what next?', options);
  if (choice === 'force') {
    w.plan.force = true;
    return 'confirm';
  }
  if (choice === 'scope') return 'scope';
  if (choice === 'range') return 'range';
  return 'done';
}

// ── S7/S8: extraction with live progress + Ctrl-C banking ───────────────────

async function stepExtract(w: Wizard, ui: WizardUi): Promise<Step> {
  const { style: st, glyphs: g } = ui;
  const found = w.found!;
  const brain = loadBrain(w.plan.target);
  const started = Date.now();

  const abort = new AbortController();
  const offCancel = ui.onCancel(() => abort.abort());
  const bar = ui.progress('mining sessions', found.sessions.length);
  const active = new Set<string>();
  const mined = new Set<string>(); // settled BEFORE any abort — safe to record
  for (const s of found.sessions.slice(0, w.plan.concurrency)) active.add(label(s));
  bar.update({ active: [...active] });

  const { proposals, failures } = await extractProposals(
    found.sessions,
    w.plan,
    brain?.nodes ?? [],
    (done, total, r) => {
      const s = r.item;
      active.delete(label(s));
      const next = found.sessions[done + w.plan.concurrency - 1];
      if (next) active.add(label(next));
      if (!abort.signal.aborted && !r.error) mined.add(s.sessionId);
      const name = label(s).slice(0, 38);
      if (r.error) {
        bar.log(`  ${st.err(g.cross)} ${name}  ${st.dim(r.error instanceof Error ? r.error.message : 'failed')}`);
      } else if (r.value?.length) {
        bar.log(`  ${st.ok(g.check)} ${name}  ${r.value.length} found   ${st.dim(`[${done}/${total}]`)}`);
      } else {
        bar.log(`  ${st.dim(`${g.dot} ${name}  nothing durable   [${done}/${total}]`)}`);
      }
      bar.update({ done, failed: failures, active: [...active] });
    },
    abort.signal,
  );
  offCancel();

  const aborted = abort.signal.aborted;

  if (!proposals.length) {
    bar.stop(
      aborted
        ? st.dim('cancelled — nothing was written, no sessions were marked imported.')
        : `nothing durable found in ${found.sessions.length} session(s) after ${fmtDuration(Date.now() - started)}.${failures ? ` ${failures} failed — re-run to retry them.` : ''}`,
    );
    return 'done';
  }

  const items = reconcileProposals(proposals, w.plan, brain, w.state);
  // On an interrupt only the sessions that actually finished may enter the
  // receipt: recording unmined ones would mark them imported at --apply time
  // and silently skip them forever.
  const sessionsRead: SessionMeta[] = aborted ? found.sessions.filter((s) => mined.has(s.sessionId)) : [...found.sessions];
  const artifacts = writePreviewArtifacts(items, w.plan, { sessions: sessionsRead }, brain, w.state);
  w.items = items;
  w.pending = artifacts.pending;

  const summary = aborted
    ? `${st.warn('interrupted')} — reviewing what ${mined.size} finished session(s) produced`
    : `${st.ok(g.check)} ${proposals.length} proposals ${g.arrow} ${st.bold(String(items.length))} after merging duplicates ${st.dim(`${g.dot} ${fmtDuration(Date.now() - started)}${failures ? ` ${g.dot} ${failures} failed` : ''}`)}`;
  bar.stop(summary);
  ui.note();
  return 'review';
}

// ── S9: the in-terminal review ──────────────────────────────────────────────

function sourceHint(item: PendingItem): string {
  const n = item.sources.length;
  const shown = item.sources
    .slice(0, 2)
    .map((s) => s.title ?? s.sessionId.slice(0, 8))
    .join(', ');
  return `${n} session${n === 1 ? '' : 's'} ${shown ? `— ${shown}` : ''}${n > 2 ? `, +${n - 2}` : ''}`;
}

export function buildChecklistSections(items: readonly PendingItem[]): ChecklistSection[] {
  const sections: ChecklistSection[] = [];
  for (const kind of SECTION_ORDER) {
    const inKind = items.filter((i) => i.kind === kind && i.status !== 'duplicate');
    if (!inKind.length) continue;
    sections.push({
      title: SECTION_TITLE[kind],
      items: inKind.map((i) => ({
        id: i.key,
        title: i.title,
        confidence: i.confidence,
        body: i.content,
        provenance: sourceHint(i),
        checked: i.checked,
      })),
    });
  }
  const dupes = items.filter((i) => i.status === 'duplicate');
  if (dupes.length) {
    sections.push({
      title: 'Already known',
      hint: 'tick one to overwrite the existing node',
      items: dupes.map((i) => ({
        id: i.key,
        title: i.title,
        confidence: i.confidence,
        body: i.content,
        provenance: sourceHint(i),
        checked: i.checked,
      })),
    });
  }
  return sections;
}

async function stepReview(w: Wizard, ui: WizardUi): Promise<Step> {
  const items = w.items!;
  const result = await ui.checklist(
    `Review what I found — ${items.length} ${items.length === 1 ? 'memory' : 'memories'}`,
    buildChecklistSections(items),
  );

  if (result === null) {
    persistCheckedState(w, items); // keep whatever state the file already had
    ui.note(`kept your preview at ${w.previewPath} — ${items.length} item(s), nothing applied.`);
    ui.note('  apply it later   nff-brain import --apply');
    return 'done';
  }

  const checkedKeys = new Set(result.checked);
  const reviewed = items.map((i) => ({ ...i, checked: checkedKeys.has(i.key) }));
  if (!reviewed.some((i) => i.checked)) {
    persistCheckedState(w, reviewed);
    ui.note(`nothing selected — brain unchanged. the preview stays at ${w.previewPath}.`);
    return 'done';
  }

  persistCheckedState(w, reviewed);
  ui.note();
  return 'apply';
}

/**
 * Re-render both artifact files with the reviewed state, so applyPhase —
 * the tested path — commits exactly what the user saw, and a crash between
 * here and the brain write leaves file and intent in agreement.
 */
function persistCheckedState(w: Wizard, items: PendingItem[]): void {
  const pending = w.pending!;
  pending.items = items;
  fs.writeFileSync(w.pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    w.previewPath,
    renderImportPreview(items, {
      brainPath: pending.brainPath,
      sessionCount: pending.sessionsRead.length,
      createdAt: pending.createdAt,
      minConfidence: pending.minConfidence,
    }),
    'utf8',
  );
}
