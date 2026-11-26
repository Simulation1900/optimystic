// Household money goals. A goal starts in the month it's set and carries over to every later month until it's
// marked done or dropped. Each kind is measured from the months themselves, so progress needs no typing.
import type { Month } from './types.js';
import { monthTotals, shortfalls } from './accounts.js';
import { budgetStats } from './budget.js';
import { r2, sumOf } from './money.js';

export type GoalKind = 'loan_payoff' | 'heloc_balance' | 'heloc_draws' | 'card_overage' | 'shortfall' | 'savings' | 'custom';
export type GoalStatus = 'active' | 'done' | 'dropped';

export interface Goal {
  id: number;
  kind: GoalKind;
  title: string;
  /** The amount to reach: a balance to get under (or to 0), a monthly cap, or a savings balance to reach. */
  target: number | null;
  /** Loan or account name the goal is about (loan_payoff, savings). */
  ref: string | null;
  /** The month to reach it by (YYYY-MM), if any. */
  dueMonth: string | null;
  startMonth: string;
  endMonth: string | null;
  status: GoalStatus;
  notes: string;
}

export const GOAL_KINDS: Record<GoalKind, { label: string; lowerIsBetter: boolean; needsRef?: 'loan' | 'account'; defaultTarget: number | null; unit: string }> = {
  loan_payoff: { label: 'Pay off a loan early', lowerIsBetter: true, needsRef: 'loan', defaultTarget: 0, unit: 'loan balance' },
  heloc_balance: { label: 'Pay down the HELOC', lowerIsBetter: true, defaultTarget: 0, unit: 'HELOC balance' },
  heloc_draws: { label: 'Cut HELOC draws', lowerIsBetter: true, defaultTarget: 0, unit: 'drawn this month' },
  card_overage: { label: 'Cut card budget overage', lowerIsBetter: true, defaultTarget: 0, unit: 'over category limits' },
  shortfall: { label: 'Close the monthly shortfall', lowerIsBetter: true, defaultTarget: 0, unit: 'short after bills' },
  savings: { label: 'Grow savings', lowerIsBetter: false, needsRef: 'account', defaultTarget: null, unit: 'account balance' },
  custom: { label: 'Something else', lowerIsBetter: true, defaultTarget: null, unit: '' }
};

const same = (a: string, b: string | null) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The goal's measure in one month, or null when that month doesn't have it (a card-only month, a loan not listed). */
export function goalValue(g: Pick<Goal, 'kind' | 'ref'>, m: Month): number | null {
  switch (g.kind) {
    case 'loan_payoff': {
      if (m.cardOnly) return null;
      const l = m.loans.find(x => same(x.name, g.ref));
      return l ? r2(Number(l.balance) || 0) : null;
    }
    case 'heloc_balance': return m.cardOnly ? null : r2(Number(m.heloc.balance) || 0);
    case 'heloc_draws': return m.cardOnly ? null : sumOf(m.heloc.draws.map(d => Number(d.amount) || 0));
    case 'card_overage': {
      const b = budgetStats(m);
      return sumOf(m.budget.cats.map(c => Math.max(0, (b.byCat[c.id] || 0) - (Number(c.limit) || 0))));
    }
    case 'shortfall': return m.cardOnly ? null : r2(Math.max(0, -monthTotals(m).left));
    case 'savings': {
      if (m.cardOnly) return null;
      const a = m.accounts.find(x => same(x.name, g.ref));
      return a ? r2(Number(a.balance) || 0) : null;
    }
    default: return null;
  }
}

export interface GoalProgress {
  series: Array<{ key: string; value: number | null }>;
  first: number | null;
  latest: number | null;
  /** Change from the first month measured to the latest, in the good direction (positive = better). */
  improvement: number | null;
  met: boolean;
  trend: 'better' | 'worse' | 'flat' | 'none';
}

/** Month-by-month measure from the goal's first month (and up to its last), with where it stands now. */
export function goalProgress(g: Goal, months: Array<[string, Month]>): GoalProgress {
  const span = months.filter(([k]) => k >= g.startMonth && (!g.endMonth || k <= g.endMonth)).sort(([a], [b]) => a.localeCompare(b));
  // Measure from the month before the goal too, so a goal set this month still shows where it started.
  const before = months.filter(([k]) => k < g.startMonth).sort(([a], [b]) => a.localeCompare(b)).slice(-1);
  const series = [...before, ...span].map(([key, m]) => ({ key, value: goalValue(g, m) }));
  const vals = series.filter(s => s.value !== null) as Array<{ key: string; value: number }>;
  const first = vals.length ? vals[0].value : null, latest = vals.length ? vals[vals.length - 1].value : null;
  const lower = GOAL_KINDS[g.kind].lowerIsBetter;
  const improvement = first !== null && latest !== null ? r2(lower ? first - latest : latest - first) : null;
  const t = g.target;
  const met = g.status === 'done' || (latest !== null && t !== null && (lower ? latest <= t + 0.004 : latest >= t - 0.004));
  const trend = improvement === null || vals.length < 2 ? 'none' : improvement > 0.004 ? 'better' : improvement < -0.004 ? 'worse' : 'flat';
  return { series, first, latest, improvement, met, trend };
}

/** One row per month of the figures goals and reviews compare. */
export function monthMetrics(key: string, m: Month) {
  const t = monthTotals(m), b = budgetStats(m);
  const overage = sumOf(m.budget.cats.map(c => Math.max(0, (b.byCat[c.id] || 0) - (Number(c.limit) || 0))));
  return {
    month: key,
    card_only: !!m.cardOnly,
    starting_balances: t.cash, cash_on_hand: t.onHand, deposits_expected: t.deposits, bills: t.bills, left_over_after_bills: t.left,
    card_spent: b.spent, card_limits: b.limit, card_overage: overage,
    // Accounts that end short get covered by a HELOC draw, so the shortfall is the draw this month will need.
    shortfall_to_heloc: m.cardOnly ? null : sumOf(shortfalls(m).map(s => s.need)),
    heloc_balance: m.cardOnly ? null : r2(Number(m.heloc.balance) || 0),
    heloc_drawn: m.cardOnly ? null : sumOf(m.heloc.draws.map(d => Number(d.amount) || 0)),
    loan_balances: m.cardOnly ? [] : m.loans.map(l => ({ name: l.name, balance: r2(Number(l.balance) || 0) })),
    account_balances: m.accounts.map(a => ({ name: a.name, balance: r2(Number(a.balance) || 0) }))
  };
}
