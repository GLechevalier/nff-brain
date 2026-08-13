// Scorecard shapes + renderers. `blocked` and `skipped-*` are first-class
// outcomes, never failures — the whole ladder is registered from day one and
// the blocked→pass transition per capability flip is the progress metric.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type Outcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'skipped-budget'
  | 'skipped-unconfigured'
  | 'skipped-gate'
  | 'needs-review'
  | 'error';

export interface RepResult {
  ok: boolean;
  detail: string;
  safetyOk?: boolean;
  safetyDetail?: string;
  durationMs: number;
  artifacts?: string[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  outcome: Outcome;
  /** Why blocked/skipped, or the failing detail. */
  reason?: string;
  reps: RepResult[];
  passRate?: number;
  requiredRate?: number;
}

export interface Scorecard {
  startedAt: string;
  finishedAt: string;
  tier: string;
  results: ScenarioResult[];
}

const OUTCOME_ICON: Record<Outcome, string> = {
  pass: '✅',
  fail: '❌',
  blocked: '⛔',
  'skipped-budget': '⏳',
  'skipped-unconfigured': '🔧',
  'skipped-gate': '🚪',
  'needs-review': '👀',
  error: '💥',
};

export function renderMarkdown(card: Scorecard): string {
  const lines = [
    `# Web-agent eval scorecard`,
    '',
    `- started: ${card.startedAt}`,
    `- finished: ${card.finishedAt}`,
    `- tier: ${card.tier}`,
    '',
    '| scenario | outcome | pass rate | detail |',
    '|---|---|---|---|',
  ];
  for (const r of card.results) {
    const rate =
      r.passRate !== undefined && r.requiredRate !== undefined
        ? `${Math.round(r.passRate * 100)}% (need ${Math.round(r.requiredRate * 100)}%)`
        : '';
    const detail = r.reason ?? r.reps.map((rep) => rep.detail).find((d) => d) ?? '';
    lines.push(`| ${r.id} | ${OUTCOME_ICON[r.outcome]} ${r.outcome} | ${rate} | ${detail.replaceAll('|', '\\|')} |`);
  }
  const counts = new Map<Outcome, number>();
  for (const r of card.results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  lines.push('', `**${[...counts.entries()].map(([o, n]) => `${n} ${o}`).join(' · ')}**`, '');
  return lines.join('\n');
}

export function writeScorecard(evalsRoot: string, card: Scorecard): string {
  const stamp = card.startedAt.replace(/[:.]/g, '-');
  const dir = path.join(evalsRoot, 'artifacts', stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scorecard.json'), JSON.stringify(card, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'scorecard.md'), renderMarkdown(card));
  return dir;
}
