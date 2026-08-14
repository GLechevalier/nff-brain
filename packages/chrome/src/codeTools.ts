// The coding agent's tool surface — code_read / code_list / code_search /
// code_write / code_edit over the user's attached project folder (File System
// Access API, handle from fsHandles.ts). The sibling of actTools.ts: same
// spec + executor shape, same NEVER-THROWS discipline, same grant-pause
// pattern, but a parallel module rather than new browser verbs — a file
// operation has no tab, no origin, and no CDP dispatch, so it must not flow
// through browserVerbs/decideAct/executeVerb (see codeGate.ts).
//
// Consent model (codeGate.ts): reads are free once a folder is attached;
// every write pauses the run with a diff the user approves in the side panel.
// Nothing is persisted beyond the run.
//
// No module-level mutable state. Per-run state lives in the ActContext /
// ActRunState, and session grants are read FRESH from nb.actRun at decision
// time — that is what makes the panel's auto-approve toggle take effect
// mid-run without threading mutable state through the loop.

import type { ToolSpec } from '@nff-brain/core/provider';
import type { ToolExecutor } from './providerClient.js';
import type { ActContext } from './actTools.js';
import { decideCode } from './codeGate.js';
import { joinJailedPath, resolveJailedPath } from './codePath.js';
import { listProjectTree, readProjectFile, searchProject, writeProjectFile } from './codeFs.js';
import { getProjectHandle } from './fsHandles.js';
import { appendTranscript, mutateActRun } from './actStore.js';
import { getActRun } from './storage.js';
import { KEYS } from './schema.js';
import type { ActPendingGrant, ActRunState } from './schema.js';

/** Same result-size budget as the browser tools' 6000-char truncation. */
export const CODE_RESULT_MAX = 6000;
/** Diff preview budget for the side panel's approval card. */
export const CODE_PREVIEW_MAX = 4096;

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Head-truncate: file reads — the interesting part of source is the top. */
export function headTruncate(text: string, max = CODE_RESULT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length} chars total]`;
}

/** Tail-truncate: command output — errors live at the END of build logs. */
export function tailTruncate(text: string, max = CODE_RESULT_MAX): string {
  if (text.length <= max) return text;
  return `[… ${text.length - max} chars omitted …]\n${text.slice(text.length - max)}`;
}

/**
 * The approval card's diff: common prefix/suffix line trim, `- old` / `+ new`
 * for the changed middle with two context lines each side. Not a real LCS —
 * a write approval needs "what changes where", not a minimal edit script.
 */
export function buildWritePreview(oldText: string | null, newText: string): { preview: string; adds: number; dels: number } {
  const clip = (s: string): string => (s.length <= CODE_PREVIEW_MAX ? s : `${s.slice(0, CODE_PREVIEW_MAX)}\n… [truncated]`);
  if (oldText === null) {
    const lines = newText.split('\n');
    return { preview: clip(['(new file)', ...lines.map((l) => `+ ${l}`)].join('\n')), adds: lines.length, dels: 0 };
  }
  if (oldText === newText) return { preview: '(no changes)', adds: 0, dels: 0 };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const dels = a.length - pre - post;
  const adds = b.length - pre - post;
  const parts = [
    `@@ line ${pre + 1}`,
    ...a.slice(Math.max(0, pre - 2), pre).map((l) => `  ${l}`),
    ...a.slice(pre, pre + dels).map((l) => `- ${l}`),
    ...b.slice(pre, pre + adds).map((l) => `+ ${l}`),
    ...a.slice(pre + dels, Math.min(a.length, pre + dels + 2)).map((l) => `  ${l}`),
  ];
  return { preview: clip(parts.join('\n')), adds, dels };
}

/** Appended to the steering prompt when a run starts code-enabled. */
export function buildCodeSteering(projectName: string): string {
  return [
    `You also have code tools on the user's real project folder "${projectName}" on their disk: code_read, code_list, code_search, code_write, code_edit.`,
    'Paths are relative to that folder. Explore with code_list and code_search, and read a file before changing it.',
    'Every write shows the user a diff to approve in the side panel — a declined write is an answer, not an error: continue, and explain what you wanted to change.',
    'Prefer code_edit (a small, exact replacement) over code_write (whole file). Changes land in real files immediately.',
  ].join(' ');
}

// ── tool specs ───────────────────────────────────────────────────────────────

const CODE_READ: ToolSpec = {
  name: 'code_read',
  description: 'Read one text file from the attached project folder. path is relative to the project root, e.g. src/index.ts.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};
const CODE_LIST: ToolSpec = {
  name: 'code_list',
  description: 'List the project as a tree. Optional path to start from and depth (default 3). node_modules, .git and build outputs are omitted.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, depth: { type: 'number' } },
  },
};
const CODE_SEARCH: ToolSpec = {
  name: 'code_search',
  description: 'Search project files with a case-insensitive regular expression. Returns path:line: match lines. Optional path to limit the search, maxResults (default 30).',
  input_schema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } },
    required: ['pattern'],
  },
};
const CODE_WRITE: ToolSpec = {
  name: 'code_write',
  description: 'Create a file, or fully replace an existing one, with the given contents. The user must approve a diff first. Prefer code_edit for small changes.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, contents: { type: 'string' } },
    required: ['path', 'contents'],
  },
};
const CODE_EDIT: ToolSpec = {
  name: 'code_edit',
  description: 'Edit one file by replacing an exact, unique text snippet. Fails if oldText matches zero or more than one place — include enough surrounding lines to be unique. The user must approve a diff first.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
    required: ['path', 'oldText', 'newText'],
  },
};

/** The code vocabulary, for merging into the paired JSON contract. */
export function codeJsonTools(): ToolSpec[] {
  return [CODE_READ, CODE_LIST, CODE_SEARCH, CODE_WRITE, CODE_EDIT];
}

// ── grant pause ──────────────────────────────────────────────────────────────

/**
 * Pause the run on a fresh code pendingGrant and wait for the panel's answer.
 * A structural copy of actTools.ts's requestGrant — kept local for the same
 * reason that one is (importing it would cycle actTools ⇄ codeTools at
 * runtime; the type-only ActContext import above erases).
 */
async function requestCodeGrant(runId: string, grant: ActPendingGrant): Promise<'once' | 'always' | 'never'> {
  const posted = await mutateActRun((r) => {
    r.phase = 'awaiting_grant';
    r.pendingGrant = grant;
    r.pendingGrantChoice = null;
  });
  if (!posted) return 'never';
  return new Promise((resolve) => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local' || !(KEYS.actRun in changes)) return;
      const v = changes[KEYS.actRun]!.newValue as ActRunState | null | undefined;
      // Answer first, abandonment second — see requestGrant's comment.
      if (v && v.id === runId && v.pendingGrantChoice != null) {
        chrome.storage.onChanged.removeListener(listener);
        resolve(v.pendingGrantChoice);
        return;
      }
      if (!v || v.id !== runId || v.phase !== 'awaiting_grant') {
        chrome.storage.onChanged.removeListener(listener);
        resolve('never');
      }
    };
    chrome.storage.onChanged.addListener(listener);
  });
}

/** THIS run's "Always" for writes — read fresh so the panel's auto-approve
 *  toggle (which mutates nb.actRun) takes effect on the very next action. */
async function writeGranted(runId: string): Promise<boolean> {
  const run = await getActRun();
  return !!(run && run.id === runId && run.codeGrants?.write);
}

// ── executors ────────────────────────────────────────────────────────────────

type ToolResult = { ok: boolean; resultText: string };

async function projectRoot(): Promise<{ root: FileSystemDirectoryHandle } | { error: string }> {
  const root = await getProjectHandle();
  if (!root) return { error: 'no project folder is attached — the user can attach one from the side panel' };
  try {
    if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      return { error: 'project folder access needs re-granting — ask the user to click Re-grant in the side panel' };
    }
  } catch {
    return { error: 'project folder access needs re-granting — ask the user to click Re-grant in the side panel' };
  }
  return { root };
}

const BAD_PATH = 'that path leaves the project (or is absolute) — use a relative path inside the project folder';

async function runCodeRead(args: Record<string, unknown>): Promise<ToolResult> {
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  const segments = resolveJailedPath(args.path);
  if (!segments) return { ok: false, resultText: BAD_PATH };
  const res = await readProjectFile(acc.root, segments);
  if (!res.ok) return { ok: false, resultText: res.error };
  await appendTranscript({ kind: 'action', text: `read ${joinJailedPath(segments)} (${res.bytes} bytes)`, ok: true });
  return { ok: true, resultText: headTruncate(res.text) };
}

async function runCodeList(args: Record<string, unknown>): Promise<ToolResult> {
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  let start: string[] | null = null;
  if (typeof args.path === 'string' && args.path.trim()) {
    start = resolveJailedPath(args.path);
    if (!start) return { ok: false, resultText: BAD_PATH };
  }
  const depth = typeof args.depth === 'number' ? Math.min(6, Math.max(1, Math.floor(args.depth))) : 3;
  const res = await listProjectTree(acc.root, start, depth);
  if (!res.ok) return { ok: false, resultText: res.error };
  const body = res.lines.length ? res.lines.join('\n') : '(empty folder)';
  return { ok: true, resultText: headTruncate(res.truncated ? `${body}\n… [more entries omitted]` : body) };
}

async function runCodeSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  if (typeof args.pattern !== 'string' || !args.pattern) return { ok: false, resultText: 'pattern is required' };
  let start: string[] | null = null;
  if (typeof args.path === 'string' && args.path.trim()) {
    start = resolveJailedPath(args.path);
    if (!start) return { ok: false, resultText: BAD_PATH };
  }
  const maxResults = typeof args.maxResults === 'number' ? Math.min(100, Math.max(1, Math.floor(args.maxResults))) : 30;
  const res = await searchProject(acc.root, args.pattern, start, maxResults);
  if (!res.ok) return { ok: false, resultText: res.error };
  if (!res.hits.length) return { ok: true, resultText: `no matches in ${res.filesScanned} files` };
  const body = res.hits.join('\n');
  return { ok: true, resultText: headTruncate(res.truncated ? `${body}\n… [more results omitted]` : body) };
}

/**
 * The shared write path for code_write and code_edit: jail → budget → diff
 * preview → gate/grant → write → transcript + budget bump. NEVER THROWS.
 */
async function performWrite(ctx: ActContext, segments: string[], oldText: string | null, newText: string): Promise<ToolResult> {
  const rel = joinJailedPath(segments);
  if (ctx.actionsTaken >= ctx.maxActions) {
    ctx.stopped = true;
    return { ok: false, resultText: `action budget of ${ctx.maxActions} reached — stopping` };
  }
  const { preview, adds, dels } = buildWritePreview(oldText, newText);
  if (oldText !== null && adds === 0 && dels === 0) return { ok: true, resultText: `${rel} already has exactly those contents — nothing to write` };
  if (decideCode({ cls: 'code-write', sessionGranted: await writeGranted(ctx.runId) }) === 'prompt') {
    const choice = await requestCodeGrant(ctx.runId, { kind: 'code-write', path: rel, preview, adds, dels });
    if (choice === 'never') {
      await appendTranscript({ kind: 'action', text: `declined write to ${rel}`, ok: false });
      return { ok: false, resultText: 'the user declined this write — continue without it, and explain what you wanted to change' };
    }
    if (choice === 'always') await mutateActRun((r) => { r.codeGrants = { ...(r.codeGrants ?? {}), write: true }; });
  }
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  const res = await writeProjectFile(acc.root, segments, newText);
  if (!res.ok) {
    await appendTranscript({ kind: 'action', text: `write to ${rel} failed`, ok: false });
    return { ok: false, resultText: res.error };
  }
  ctx.actionsTaken++;
  await appendTranscript({ kind: 'action', text: `wrote ${rel} (+${adds} −${dels})`, ok: true });
  await mutateActRun((r) => { r.actionsTaken = ctx.actionsTaken; });
  return { ok: true, resultText: `wrote ${rel} (${res.bytes} chars, +${adds} −${dels})` };
}

async function runCodeWrite(ctx: ActContext, args: Record<string, unknown>): Promise<ToolResult> {
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  const segments = resolveJailedPath(args.path);
  if (!segments) return { ok: false, resultText: BAD_PATH };
  if (typeof args.contents !== 'string') return { ok: false, resultText: 'contents (a string) is required' };
  const existing = await readProjectFile(acc.root, segments);
  return performWrite(ctx, segments, existing.ok ? existing.text : null, args.contents);
}

async function runCodeEdit(ctx: ActContext, args: Record<string, unknown>): Promise<ToolResult> {
  const acc = await projectRoot();
  if ('error' in acc) return { ok: false, resultText: acc.error };
  const segments = resolveJailedPath(args.path);
  if (!segments) return { ok: false, resultText: BAD_PATH };
  if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') {
    return { ok: false, resultText: 'oldText (non-empty) and newText (strings) are required' };
  }
  const rel = joinJailedPath(segments);
  const existing = await readProjectFile(acc.root, segments);
  if (!existing.ok) return { ok: false, resultText: existing.error };
  const count = existing.text.split(args.oldText).length - 1;
  if (count === 0) return { ok: false, resultText: `oldText not found in ${rel} — code_read it and copy the snippet exactly` };
  if (count > 1) return { ok: false, resultText: `oldText matches ${count} places in ${rel} — include more surrounding lines so it is unique` };
  const newContents = existing.text.replace(args.oldText, args.newText);
  return performWrite(ctx, segments, existing.text, newContents);
}

/**
 * Run one code tool by name — the paired JSON loop's entry point, and the
 * body each BYOK executor wraps. NEVER THROWS (same contract as runVerb).
 */
export async function runCodeByName(ctx: ActContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (ctx.stopped) return { ok: false, resultText: 'the run was stopped' };
  if (!ctx.codeEnabled) return { ok: false, resultText: 'code tools are not enabled for this run' };
  try {
    switch (name) {
      case 'code_read':
        return await runCodeRead(args);
      case 'code_list':
        return await runCodeList(args);
      case 'code_search':
        return await runCodeSearch(args);
      case 'code_write':
        return await runCodeWrite(ctx, args);
      case 'code_edit':
        return await runCodeEdit(ctx, args);
      default:
        return { ok: false, resultText: `unknown code tool ${name}` };
    }
  } catch (err) {
    // Same never-throw posture as runVerb: an uncaught rejection here would
    // silently kill the whole run loop (see runVerb's comment in actTools.ts).
    const msg = err instanceof Error ? err.message : 'the file operation failed unexpectedly';
    await appendTranscript({ kind: 'action', text: msg, ok: false });
    return { ok: false, resultText: msg };
  }
}

/** BYOK executors for the code vocabulary — merged in by buildActTools(). */
export function buildCodeTools(ctx: ActContext): ToolExecutor[] {
  return codeJsonTools().map((spec) => ({
    spec,
    run: async (input) => {
      const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      return runCodeByName(ctx, spec.name, obj);
    },
  }));
}
