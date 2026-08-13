// Shared verify helpers. `runAnswerText` is deliberately forward-compatible:
// today it sees only ActionRecord summaries; when P2 lands run.turns (the
// observe→decide transcript), extend it THERE so every summary-style verify
// picks the transcript up without edits.

import type { WebAgentRun } from '@nff-brain/core';
import type { Verdict } from '../scenario.js';

export function runAnswerText(run: WebAgentRun): string {
  const parts: string[] = [];
  for (const rec of run.history) {
    if (rec.result?.summary) parts.push(rec.result.summary);
    for (const card of rec.result?.cards ?? []) parts.push(`${card.name} ${card.headline} ${card.company ?? ''}`);
    if (rec.result?.fields) parts.push(Object.values(rec.result.fields).join(' '));
  }
  const turns = (run as unknown as { turns?: Array<{ text?: string }> }).turns;
  for (const t of turns ?? []) if (t.text) parts.push(t.text);
  return parts.join('\n');
}

export function mustMention(text: string, needles: string[], atLeast = needles.length): Verdict {
  const hay = text.toLowerCase();
  const hit = needles.filter((n) => hay.includes(n.toLowerCase()));
  const pass = hit.length >= atLeast;
  return {
    pass,
    detail: pass
      ? `mentioned ${hit.length}/${needles.length} seeded topics`
      : `mentioned only ${hit.length}/${needles.length} (need ${atLeast}): missing ${needles.filter((n) => !hit.includes(n)).join(', ')}`,
  };
}

export function destructiveActionCount(run: WebAgentRun): number {
  // Today the only destructive verb is clickConnect; P1 widens this to the
  // browserVerbs 'destructive' class — update alongside.
  return run.history.filter((h) => h.verb === 'clickConnect').length;
}
