// Persistent per-site action budgets + cooldowns — the ToS-safety encoding.
// LinkedIn defaults: 5 connect-units/day, 45-min cooldown between LinkedIn
// scenarios. The ledger survives runner restarts on purpose: re-running the
// suite five times in an afternoon must NOT multiply the spend.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SiteId } from './scenario.js';

export interface SiteBudget {
  /** Units spendable per UTC day. */
  dailyUnits: number;
  /** Minimum gap between two scenarios on this site. */
  cooldownMs: number;
}

export const DEFAULT_BUDGETS: Partial<Record<SiteId, SiteBudget>> = {
  linkedin: { dailyUnits: 5, cooldownMs: 45 * 60 * 1000 },
};

interface LedgerDay {
  day: string; // 'YYYY-MM-DD' UTC
  spent: Partial<Record<SiteId, number>>;
  lastRunAt: Partial<Record<SiteId, number>>;
}

export function budgetsPath(evalsRoot: string): string {
  return path.join(evalsRoot, 'state', 'budgets.json');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function readLedger(evalsRoot: string): LedgerDay {
  try {
    const raw = JSON.parse(fs.readFileSync(budgetsPath(evalsRoot), 'utf8')) as LedgerDay;
    if (raw.day === today()) return { day: raw.day, spent: raw.spent ?? {}, lastRunAt: raw.lastRunAt ?? {} };
    // New day: units reset, cooldown timestamps carry over.
    return { day: today(), spent: {}, lastRunAt: raw.lastRunAt ?? {} };
  } catch {
    return { day: today(), spent: {}, lastRunAt: {} };
  }
}

function writeLedger(evalsRoot: string, ledger: LedgerDay): void {
  const p = budgetsPath(evalsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n');
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

export function checkBudget(evalsRoot: string, site: SiteId, costUnits: number): BudgetVerdict {
  const budget = DEFAULT_BUDGETS[site];
  if (!budget) return { ok: true };
  const ledger = readLedger(evalsRoot);
  const spent = ledger.spent[site] ?? 0;
  if (spent + costUnits > budget.dailyUnits) {
    return { ok: false, reason: `daily ${site} budget exhausted (${spent}/${budget.dailyUnits} units spent)` };
  }
  const last = ledger.lastRunAt[site] ?? 0;
  const waitMs = last + budget.cooldownMs - Date.now();
  if (waitMs > 0) {
    return { ok: false, reason: `${site} cooldown — ${Math.ceil(waitMs / 60000)}m left` };
  }
  return { ok: true };
}

export function chargeBudget(evalsRoot: string, site: SiteId, costUnits: number): void {
  const ledger = readLedger(evalsRoot);
  ledger.spent[site] = (ledger.spent[site] ?? 0) + costUnits;
  ledger.lastRunAt[site] = Date.now();
  writeLedger(evalsRoot, ledger);
}
