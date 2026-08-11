import { describe, expect, it } from 'vitest';
import {
  ARRAY_BY_KIND,
  CATEGORIES,
  CATEGORY_BY_KIND,
  IMPORT_KINDS,
  MAX_CONTENT,
  MAX_TITLE,
  NFF_PROMPT_MARKERS,
  adjustConfidence,
  ageDaysOf,
  buildImportPrompt,
  hasCorrection,
  parseImportResponse,
  type ParseContext,
} from '../src/index.js';

const SESSION = { sessionId: 's1', title: 'a session', date: '2026-08-01T00:00:00.000Z' };
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  session: SESSION,
  transcriptChars: 8000,
  hasCorrection: false,
  ageDays: 0,
  ...over,
});

describe('buildImportPrompt', () => {
  const prompt = buildImportPrompt({
    taskText: 'make the thing work',
    transcript: '[user] hi\n[assistant] hello',
    knownNodes: [],
    maxPerKind: 4,
    maxTranscriptChars: 12_000,
  });

  it('carries the archaeologist marker so the session is recognisable as ours', () => {
    // claudeHistory's one-shot detector keys on this exact string.
    expect(prompt.startsWith(NFF_PROMPT_MARKERS.archaeologist)).toBe(true);
  });

  it('names all five arrays and their target categories', () => {
    for (const kind of IMPORT_KINDS) {
      expect(prompt).toContain(`"${ARRAY_BY_KIND[kind]}"`);
      expect(prompt).toContain(CATEGORY_BY_KIND[kind]);
    }
  });

  it('maps every kind to a real category', () => {
    for (const kind of IMPORT_KINDS) {
      expect(CATEGORIES).toContain(CATEGORY_BY_KIND[kind]);
    }
    expect(CATEGORY_BY_KIND.failure).toBe('analysis');
  });

  it('says empty is an acceptable answer, so routine sessions are not padded', () => {
    expect(prompt).toMatch(/empty arrays are the right answer/i);
  });

  it('truncates the transcript to the stated budget', () => {
    const long = buildImportPrompt({
      taskText: '',
      transcript: 'x'.repeat(50_000),
      knownNodes: [],
      maxPerKind: 4,
      maxTranscriptChars: 1_000,
    });
    expect(long).not.toContain('x'.repeat(1_001));
  });
});

describe('parseImportResponse', () => {
  it('reads all five arrays and routes each to its category', () => {
    const raw = JSON.stringify({
      memories: [{ title: 'M', content: 'mc', confidence: 0.8 }],
      decisions: [{ title: 'D', content: 'dc', confidence: 0.8 }],
      preferences: [{ title: 'P', content: 'pc', confidence: 0.8 }],
      tasks: [{ title: 'T', content: 'tc', confidence: 0.8 }],
      failures: [{ title: 'F', content: 'fc', confidence: 0.8 }],
    });
    const out = parseImportResponse(raw, ctx());
    expect(out.map((p) => p.kind)).toEqual(['memory', 'decision', 'preference', 'task', 'failure']);
    expect(out.map((p) => p.category)).toEqual([
      'strategy',
      'decision',
      'preference',
      'task',
      'analysis',
    ]);
    expect(out[0].sources).toEqual([SESSION]);
  });

  it('survives code fences and a prose preamble', () => {
    const raw = 'Sure! Here you go:\n```json\n{"memories":[{"title":"M","content":"c","confidence":0.7}]}\n```\nHope that helps.';
    expect(parseImportResponse(raw, ctx())).toHaveLength(1);
  });

  it('tolerates missing arrays, junk entries and unparseable output', () => {
    expect(parseImportResponse('{"memories":[{"title":"only a title"}]}', ctx())).toEqual([]);
    expect(parseImportResponse('{"memories":[null,3,"x"]}', ctx())).toEqual([]);
    expect(parseImportResponse('total garbage', ctx())).toEqual([]);
    expect(parseImportResponse('', ctx())).toEqual([]);
    expect(parseImportResponse('{"memories":"not an array"}', ctx())).toEqual([]);
  });

  it('truncates over-long titles and bodies', () => {
    const raw = JSON.stringify({
      memories: [{ title: 'T'.repeat(300), content: 'C'.repeat(2000), confidence: 0.9 }],
    });
    const [p] = parseImportResponse(raw, ctx());
    expect(p.title).toHaveLength(MAX_TITLE);
    expect(p.content).toHaveLength(MAX_CONTENT);
  });

  it('reads worded and percentage confidences rather than dropping to default', () => {
    const raw = JSON.stringify({
      memories: [
        { title: 'a', content: 'c', confidence: 'high' },
        { title: 'b', content: 'c', confidence: 'low' },
        { title: 'c', content: 'c', confidence: 85 },
        { title: 'd', content: 'c' },
        { title: 'e', content: 'c', confidence: 999 },
      ],
    });
    const out = parseImportResponse(raw, ctx());
    // 85 is the 0-100 scale; a missing value defaults mid; anything absurd is
    // clamped rather than trusted. (A single-digit >1 like `4` is read as 4%,
    // which is a don't-care: a model that ignores an explicit 0..1 field is
    // unreliable either way, and the item still appears in the preview.)
    expect(out.map((p) => p.llmConfidence)).toEqual([0.9, 0.35, 0.85, 0.5, 1]);
  });

  it('caps entries per array', () => {
    const raw = JSON.stringify({
      memories: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: 'c', confidence: 0.7 })),
    });
    expect(parseImportResponse(raw, ctx({ maxPerKind: 3 }))).toHaveLength(3);
  });
});

describe('adjustConfidence', () => {
  const base = { transcriptChars: 8000, hasCorrection: false, ageDays: 0 };

  it('leaves a long clean session untouched', () => {
    expect(adjustConfidence(0.8, 'memory', base)).toBeCloseTo(0.8, 3);
  });

  it('discounts a short session', () => {
    expect(adjustConfidence(0.8, 'memory', { ...base, transcriptChars: 2000 })).toBeLessThan(0.8);
  });

  it('discounts a contested memory but not a preference', () => {
    const c = { ...base, hasCorrection: true };
    expect(adjustConfidence(0.8, 'memory', c)).toBeLessThan(0.8);
    expect(adjustConfidence(0.8, 'failure', c)).toBeLessThan(0.8);
    expect(adjustConfidence(0.8, 'preference', c)).toBeCloseTo(0.8, 3);
  });

  it('discounts a stale task only', () => {
    const old = { ...base, ageDays: 90 };
    expect(adjustConfidence(0.8, 'task', old)).toBeLessThan(0.8);
    expect(adjustConfidence(0.8, 'decision', old)).toBeCloseTo(0.8, 3);
  });

  it('never leaves 0..1', () => {
    expect(adjustConfidence(1, 'memory', base)).toBeLessThanOrEqual(1);
    expect(adjustConfidence(0, 'memory', base)).toBeGreaterThanOrEqual(0);
  });
});

describe('hasCorrection', () => {
  it('fires on a user push-back, not on assistant prose', () => {
    expect(hasCorrection('[user] no, that is not what I meant')).toBe(true);
    expect(hasCorrection('[user] actually use tsup instead')).toBe(true);
    expect(hasCorrection('[assistant] actually the bug was elsewhere')).toBe(false);
    expect(hasCorrection('[user] looks great, ship it')).toBe(false);
  });
});

describe('ageDaysOf', () => {
  it('counts whole days and shrugs at nonsense', () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    expect(ageDaysOf('2026-08-01T00:00:00.000Z', now)).toBe(10);
    expect(ageDaysOf(null, now)).toBe(0);
    expect(ageDaysOf('not a date', now)).toBe(0);
    expect(ageDaysOf('2026-09-01T00:00:00.000Z', now)).toBe(0); // future → clamped
  });
});
