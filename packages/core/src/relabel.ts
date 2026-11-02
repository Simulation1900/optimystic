// Relabel a month (e.g. the HTML planner's "November 2026" that really held October's bills and income).
import type { Month } from './types.js';
import { addMonths, monthLabel } from './dates.js';
import { buildNewMonth } from './newMonth.js';
import { PlannerError } from './heloc.js';
import { clone, uid } from './ids.js';

export interface RelabelPlan {
  /** The months to write, by key. `from` is removed (unless it's also a key here). */
  write: Record<string, Month>;
  created: string[];
  moved: Record<string, number>;
}

/**
 * Move month `from` to the label `to`, keeping its accounts, bills (paid ticks and applied loan/HELOC payments as
 * recorded), transfers, loans, HELOC and card settings. Card charges stay filed by their own dates: those dated in
 * `to` stay, those dated in the month after `to` go to that month, which is created from `to`'s ending balances
 * (with deposits, recurring bills and monthly transfers) if it doesn't exist. `existing` holds any months already
 * in the planner that charges may move into.
 */
export function planRelabel(src: Month, from: string, to: string, existing: Record<string, Month>, newId: () => string = uid): RelabelPlan {
  if (from === to) throw new PlannerError('That’s already its label.');
  if (existing[to] && to !== from) throw new PlannerError(`${monthLabel(to)} already exists. Delete it first, or pick another month.`, 409);
  const m = clone(src);
  delete m.meta;
  const next = addMonths(to, 1);
  const charges = m.budget.expenses;
  m.budget.expenses = charges.filter(e => e.date.slice(0, 7) === to);
  const rest = charges.filter(e => e.date.slice(0, 7) !== to);
  const write: Record<string, Month> = { [to]: m };
  const created: string[] = [];
  const moved: Record<string, number> = {};
  for (const e of rest) {
    const k = e.date.slice(0, 7);
    if (!write[k]) {
      if (existing[k] && k !== from) write[k] = clone(existing[k]);
      else if (k === next) { write[k] = buildNewMonth(m, { balances: 'forecast', cardBills: 'keep', copyOneTime: false }, newId); created.push(k); }
      else throw new PlannerError(`A card charge from ${e.date} (${e.desc}) has no month to go to. Start ${monthLabel(k)} first, or remove that charge.`, 422);
    }
    write[k].budget.expenses.push(e);
    moved[k] = (moved[k] || 0) + 1;
  }
  // The month after the new label always exists afterwards, so the planner carries on from where it really is.
  if (!write[next] && !existing[next]) { write[next] = buildNewMonth(m, { balances: 'forecast', cardBills: 'keep', copyOneTime: false }, newId); created.push(next); }
  return { write, created, moved };
}
