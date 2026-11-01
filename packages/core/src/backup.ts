import type { Month, PlannerState } from './types.js';
import { normalizeMonth, validState } from './defaults.js';
import { isMonthKey } from './dates.js';
import { ensureColors, monthTotals } from './accounts.js';
import { budgetStats } from './budget.js';
import { restoreOldDeductions } from './payments.js';
import { clone } from './ids.js';

export class BackupError extends Error {}

/**
 * Read a `bill-planner-backup-*.json` file (any version) into a clean planner state:
 * very old single-month files are wrapped, missing parts are filled in, and rule 13's
 * `balanceApplied` amounts are added back to the balances.
 */
export function readBackup(input: unknown): PlannerState {
  let s: unknown = typeof input === 'string' ? JSON.parse(input) : clone(input);
  const old = s as { accounts?: unknown; bills?: unknown; month?: string } | null;
  if (!validState(s) && old && Array.isArray(old.accounts)) {
    const k = old.month || '2026-11';
    s = { current: k, months: { [k]: { accounts: old.accounts, bills: old.bills } as unknown as Month } };
  }
  if (!validState(s)) throw new BackupError('That file doesn’t look like a Bill Planner backup.');
  const months: Record<string, Month> = {};
  for (const [k, m] of Object.entries(s.months)) {
    if (!isMonthKey(k)) throw new BackupError(`“${k}” isn’t a month (expected YYYY-MM).`);
    months[k] = normalizeMonth(m, k);
  }
  const st = restoreOldDeductions({ current: s.current, months });
  Object.values(st.months).forEach(ensureColors);
  return st;
}

/** Strip server bookkeeping so an export reads exactly like the HTML planner's backups. */
export function toBackup(st: PlannerState): PlannerState {
  const clean = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      const r: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === 'version' || k === 'updatedAt' || k === 'updatedBy' || k === 'meta') continue;
        r[k] = clean(v);
      }
      return r;
    }
    return o;
  };
  return clean(st) as PlannerState;
}

/** The figures the import check screen compares, to the cent. */
export interface MonthCheck {
  key: string;
  accounts: Array<{ id: string; name: string; left: number }>;
  householdLeft: number;
  loans: Array<{ id: string; name: string; balance: number }>;
  helocBalance: number;
  helocAvailable: number;
  budgetSpent: number;
  budgetLimit: number;
  cardBillsNext: number;
  expenses: number;
}

export function monthCheck(key: string, m: Month): MonthCheck {
  const t = monthTotals(m), b = budgetStats(m);
  return {
    key,
    accounts: m.accounts.map(a => ({ id: a.id, name: a.name, left: t.accounts[a.id].left })),
    householdLeft: t.left,
    loans: m.loans.map(l => ({ id: l.id, name: l.name, balance: l.balance })),
    helocBalance: m.heloc.balance,
    helocAvailable: m.heloc.available,
    budgetSpent: b.spent,
    budgetLimit: b.limit,
    cardBillsNext: b.projected,
    expenses: m.budget.expenses.length
  };
}

export const stateCheck = (st: PlannerState): MonthCheck[] =>
  Object.keys(st.months).sort().map(k => monthCheck(k, st.months[k]));
