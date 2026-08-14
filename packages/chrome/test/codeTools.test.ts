import { describe, expect, it } from 'vitest';
import {
  buildCodeSteering,
  buildWritePreview,
  codeJsonTools,
  headTruncate,
  tailTruncate,
} from '../src/codeTools.js';
import { actContractTools, buildPairedActPrompt, PAIRED_BOOTSTRAP_MAX, renderActContract } from '../src/actTools.js';

describe('truncation', () => {
  it('headTruncate keeps the top and names the loss', () => {
    expect(headTruncate('short')).toBe('short');
    const out = headTruncate('x'.repeat(7000), 6000);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('[truncated, 7000 chars total]');
  });

  it('tailTruncate keeps the END — build errors live there', () => {
    const out = tailTruncate(`${'a'.repeat(7000)}THE ERROR`, 6000);
    expect(out).toContain('THE ERROR');
    expect(out.startsWith('[… 1009 chars omitted …]')).toBe(true);
  });
});

describe('buildWritePreview', () => {
  it('marks a new file and counts every line as an add', () => {
    const p = buildWritePreview(null, 'a\nb');
    expect(p.preview).toContain('(new file)');
    expect(p.adds).toBe(2);
    expect(p.dels).toBe(0);
  });

  it('shows only the changed middle with context and counts', () => {
    const oldText = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const newText = ['one', 'two', 'CHANGED', 'four', 'five'].join('\n');
    const p = buildWritePreview(oldText, newText);
    expect(p.adds).toBe(1);
    expect(p.dels).toBe(1);
    expect(p.preview).toContain('- three');
    expect(p.preview).toContain('+ CHANGED');
    expect(p.preview).toContain('@@ line 3');
    expect(p.preview).not.toContain('- one'); // unchanged lines are context, not deletions
  });

  it('reports identical contents as no changes', () => {
    expect(buildWritePreview('same', 'same')).toEqual({ preview: '(no changes)', adds: 0, dels: 0 });
  });

  it('caps the preview for the panel', () => {
    const p = buildWritePreview(null, 'y'.repeat(50_000));
    expect(p.preview.length).toBeLessThan(5000);
    expect(p.preview).toContain('[truncated]');
  });
});

describe('the code tool contract', () => {
  it('exposes exactly the five fs tools, all code_-prefixed', () => {
    const names = codeJsonTools().map((t) => t.name);
    expect(names).toEqual(['code_read', 'code_list', 'code_search', 'code_write', 'code_edit']);
  });

  it('actContractTools appends them only when code is enabled', () => {
    const browserOnly = actContractTools(false).map((t) => t.name);
    expect(browserOnly).not.toContain('code_read');
    const withCode = actContractTools(true).map((t) => t.name);
    expect(withCode.slice(0, browserOnly.length)).toEqual(browserOnly);
    expect(withCode).toContain('code_edit');
  });

  it('renderActContract lists the code tools for a code-enabled run', () => {
    expect(renderActContract(actContractTools(true))).toContain('code_search');
    expect(renderActContract()).not.toContain('code_search');
  });

  it('steering names the project and the approval rule', () => {
    const s = buildCodeSteering('my-app');
    expect(s).toContain('"my-app"');
    expect(s).toContain('approve');
  });
});

describe('buildPairedActPrompt bootstrap clamp', () => {
  it('drops oldest history pairs until the bootstrap fits', () => {
    const history: string[] = [];
    for (let i = 0; i < 40; i++) {
      history.push(`> {"action":"code_read","args":{"path":"f${i}.ts"}}`);
      history.push(`= ${'r'.repeat(5000)} END${i}`);
    }
    const prompt = buildPairedActPrompt('SYSTEM', history);
    expect(prompt.length).toBeLessThanOrEqual(PAIRED_BOOTSTRAP_MAX);
    // The newest exchange survives; the oldest is gone.
    expect(prompt).toContain('END39');
    expect(prompt).not.toContain('"f0.ts"');
  });

  it('leaves a small history untouched', () => {
    const prompt = buildPairedActPrompt('SYSTEM', ['> a', '= b']);
    expect(prompt).toContain('> a');
    expect(prompt).toContain('= b');
  });
});
