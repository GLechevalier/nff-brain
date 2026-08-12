// Shared synthetic ~/.claude history for the import suites, so the e2e and
// wizard tests exercise identical fixtures and cannot drift apart.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Encode a cwd the way Claude Code names its project folders. */
export const encodeCwd = (cwd: string): string => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

/** A synthetic transcript, padded past the size floors. */
export function writeSession(
  home: string,
  sessionId: string,
  opts: { marker?: string; title?: string; cwd: string },
): void {
  const dir = path.join(home, 'projects', encodeCwd(opts.cwd));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId, cwd: opts.cwd, version: '2.1.210', gitBranch: 'main' };
  const lines: string[] = [
    // Real transcripts open with a state record carrying no cwd.
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId }),
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', content: `Please fix the thing. ${opts.marker ?? ''}` },
      timestamp: '2026-08-01T10:00:00.000Z',
    }),
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', content: 'and also the other thing' },
      timestamp: '2026-08-01T10:05:00.000Z',
    }),
    JSON.stringify({
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `working on it ${'y'.repeat(6000)}` }] },
      timestamp: '2026-08-01T10:06:00.000Z',
    }),
  ];
  if (opts.title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId }));
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n'));
}

/** nff-brain's OWN claude -p transcript — must always be skipped by import. */
export function writeOneShot(home: string, cwd: string, sessionId = 'sess-oneshot'): void {
  const dir = path.join(home, 'projects', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({
        type: 'user',
        cwd,
        message: { role: 'user', content: `You are the memory distiller for a coding agent. ${'z'.repeat(6000)}` },
      }),
    ].join('\n'),
  );
}

/** Wrap the claude shim in a platform-appropriate executable. */
export function makeClaudeShim(shimDir: string, shimJs: string): string {
  if (process.platform === 'win32') {
    const bin = path.join(shimDir, 'claude.cmd');
    fs.writeFileSync(bin, `@echo off\r\nnode "${shimJs}" %*\r\n`);
    return bin;
  }
  const bin = path.join(shimDir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${shimJs}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}
