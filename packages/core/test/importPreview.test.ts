import { describe, expect, it } from 'vitest';
import {
  parseImportPreview,
  renderImportPreview,
  resolvePreview,
  type PendingFile,
  type PendingItem,
} from '../src/index.js';

function item(over: Partial<PendingItem> = {}): PendingItem {
  return {
    key: 'm1',
    id: 'retry-renamesync-on-windows-eperm',
    status: 'new',
    kind: 'memory',
    category: 'strategy',
    title: 'Retry renameSync on Windows EPERM',
    content: 'Defender briefly locks the destination, so the atomic save must retry the rename.',
    confidence: 0.82,
    checked: true,
    sources: [{ sessionId: 's1', title: 'atomic-save-fix', date: '2026-08-04T00:00:00.000Z' }],
    hash: 'memory:retry-renamesync-on-windows-eperm',
    ...over,
  };
}

const ctx = {
  brainPath: 'D:\\repo\\.nff-brain\\brain.json',
  sessionCount: 12,
  createdAt: '2026-08-11T09:12:04.000Z',
  minConfidence: 0.5,
};

function pendingFile(items: PendingItem[]): PendingFile {
  return {
    version: 1,
    createdAt: ctx.createdAt,
    workspaceRoot: 'D:\\repo',
    brainPath: ctx.brainPath,
    brainUpdatedAt: '2026-08-11T09:00:00.000Z',
    minConfidence: 0.5,
    sessionsRead: ['s1'],
    items,
  };
}

describe('renderImportPreview', () => {
  it('groups by kind, shows the checkbox, confidence and provenance', () => {
    const md = renderImportPreview(
      [
        item(),
        item({ key: 'd1', kind: 'decision', category: 'decision', title: 'Bundle with tsup', checked: true }),
        item({ key: 't1', kind: 'task', category: 'task', title: 'Wire the doctor line', checked: false, confidence: 0.31 }),
      ],
      ctx,
    );
    expect(md).toContain('## Durable memories (1)');
    expect(md).toContain('## Architectural decisions (1)');
    expect(md).toContain('## Unresolved tasks (1)');
    expect(md).toContain('- [x] **Retry renameSync on Windows EPERM** `0.82`');
    expect(md).toContain('- [ ] **Wire the doctor line** `0.31`');
    expect(md).toContain('<!-- nb:m1 -->');
    expect(md).toContain('1 session — "atomic-save-fix" (2026-08-04)');
    expect(md).toContain('nff-brain import --apply');
  });

  it('puts duplicates in their own section, unchecked, with the target named', () => {
    const md = renderImportPreview(
      [item({ key: 'm9', status: 'duplicate', targetId: 'win-rename', checked: false, previousContent: 'Old wording.' })],
      ctx,
    );
    expect(md).toContain('## Already known (1)');
    expect(md).toContain('already `win-rename`');
    expect(md).toContain('> was: Old wording.');
    expect(md).not.toContain('## Durable memories');
  });

  it('marks a refine with its target', () => {
    const md = renderImportPreview([item({ status: 'refine', targetId: 'docker-fix', previousContent: 'Old.' })], ctx);
    expect(md).toContain('refines `docker-fix`');
  });

  it('says so plainly when nothing was found', () => {
    expect(renderImportPreview([], ctx)).toContain('Nothing worth keeping');
  });

  it('summarises counts in the header', () => {
    const md = renderImportPreview(
      [item(), item({ key: 'm2', checked: false }), item({ key: 'm3', status: 'duplicate', checked: false })],
      ctx,
    );
    expect(md).toContain('1 checked (confidence ≥ 0.50) · 1 unchecked (low confidence) · 1 already known');
  });
});

describe('parseImportPreview round-trip', () => {
  it('reads back exactly what was written', () => {
    const items = [item(), item({ key: 'd1', kind: 'decision', title: 'Bundle with tsup', checked: false })];
    const parsed = parseImportPreview(renderImportPreview(items, ctx));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.edits.get('m1')).toEqual({
      checked: true,
      title: 'Retry renameSync on Windows EPERM',
      content: 'Defender briefly locks the destination, so the atomic save must retry the rename.',
    });
    expect(parsed.edits.get('d1')?.checked).toBe(false);
  });

  it('keeps a multi-line body and drops the provenance and was: lines', () => {
    const md = renderImportPreview([item({ content: 'First line.\n\nSecond paragraph.', previousContent: 'Old.' })], ctx);
    const edit = parseImportPreview(md).edits.get('m1')!;
    expect(edit.content).toBe('First line.\n\nSecond paragraph.');
    expect(edit.content).not.toContain('session');
    expect(edit.content).not.toContain('was:');
  });
});

describe('resolvePreview', () => {
  const pending = pendingFile([
    item(),
    item({ key: 'd1', kind: 'decision', title: 'Bundle with tsup', id: 'bundle-with-tsup' }),
  ]);

  it('accepts only the checked items', () => {
    const md = renderImportPreview(pending.items, ctx).replace('- [x] **Bundle with tsup**', '- [ ] **Bundle with tsup**');
    const r = resolvePreview(pending, md);
    expect(r.accepted.map((i) => i.key)).toEqual(['m1']);
    expect(r.rejected).toBe(1);
  });

  it('honours an edited title and body but never changes the id', () => {
    const md = renderImportPreview(pending.items, ctx)
      .replace('**Retry renameSync on Windows EPERM**', '**Retry renameSync on Windows (EPERM)**')
      .replace('Defender briefly locks the destination, so the atomic save must retry the rename.', 'Rewritten by hand.');
    const r = resolvePreview(pending, md);
    const m1 = r.accepted.find((i) => i.key === 'm1')!;
    expect(m1.title).toBe('Retry renameSync on Windows (EPERM)');
    expect(m1.content).toBe('Rewritten by hand.');
    expect(m1.edited).toBe(true);
    // The id was collision-checked when the preview was written — re-slugging
    // an edited title here could silently collide with a different node.
    expect(m1.id).toBe('retry-renamesync-on-windows-eperm');
  });

  it('treats a deleted block as rejected, not as still-pending', () => {
    const md = renderImportPreview(pending.items, ctx)
      .split('\n')
      .filter((l) => !l.includes('nb:d1'))
      .join('\n');
    const r = resolvePreview(pending, md);
    expect(r.accepted.map((i) => i.key)).toEqual(['m1']);
    expect(r.rejected).toBe(1);
  });

  it('warns but does not throw on a damaged marker', () => {
    const md = renderImportPreview(pending.items, ctx).replace('<!-- nb:d1 -->', '<!-- nb-broken -->');
    const r = resolvePreview(pending, md);
    expect(r.accepted.map((i) => i.key)).toEqual(['m1']);
    expect(r.warnings.join(' ')).toMatch(/no nb: marker/);
  });

  it('warns on a marker that matches nothing pending', () => {
    const md = `${renderImportPreview(pending.items, ctx)}\n- [x] **Invented** \`0.9\` <!-- nb:zz9 -->\n  body\n`;
    const r = resolvePreview(pending, md);
    expect(r.warnings.join(' ')).toMatch(/unknown marker nb:zz9/);
    expect(r.accepted).toHaveLength(2);
  });

  it('rejects everything when the file is empty or missing content', () => {
    expect(resolvePreview(pending, '').accepted).toEqual([]);
    expect(resolvePreview(pending, '').rejected).toBe(2);
  });

  it('falls back to the stored text when the reviewer blanks a body', () => {
    const md = renderImportPreview([item()], ctx).replace(
      '  Defender briefly locks the destination, so the atomic save must retry the rename.',
      '  ',
    );
    const r = resolvePreview(pendingFile([item()]), md);
    expect(r.accepted[0].content).toBe(item().content);
    expect(r.accepted[0].edited).toBe(false);
  });
});
