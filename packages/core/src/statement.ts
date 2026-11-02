// Card statements: each card's bill is the statement that closes during the month (paid in full around the 25th).
import type { Month } from './types.js';
import { r2 } from './money.js';
import { addMonths, daysIn } from './dates.js';

const iso = (key: string, day: number) => `${key}-${String(Math.min(day, daysIn(key))).padStart(2, '0')}`;
const dayAfter = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;

/** The statement cycle that closes in month `key`: from the day after last month's closing to this month's. */
export function cycleClosingIn(key: string, closeDay: number): { start: string; end: string } {
  return { start: dayAfter(iso(addMonths(key, -1), closeDay)), end: iso(key, closeDay) };
}

export interface Statement {
  cardId: string; cardName: string; billName: string;
  start: string; end: string; dueDate: string | null;
  /** Net charges in the cycle so far (returns subtract). */
  soFar: number;
  closed: boolean;
  /** The bill: the statement total once closed; before that, charges so far + the card's budget for the days left. */
  amount: number;
  /** Charges in the cycle dated in a month the planner doesn't have (so the total may be short). */
  incomplete: boolean;
}

/**
 * The statement each card with a closing day has in month `key`. `months` needs `key` and the month before it
 * (a cycle straddles the two); `today` is 'YYYY-MM-DD' in the household's time zone.
 */
export function statementsFor(months: Record<string, Month>, key: string, today: string): Statement[] {
  const m = months[key];
  if (!m) return [];
  const prevKey = addMonths(key, -1);
  return m.budget.cards.filter(c => c.closeDay).map(c => {
    const { start, end } = cycleClosingIn(key, c.closeDay!);
    const charges = [m, months[prevKey]].filter(Boolean).flatMap(x => x!.budget.expenses)
      .filter(e => e.cardId === c.id && e.date >= start && e.date <= end);
    const soFar = r2(charges.reduce((t, e) => t + Math.round(e.amount * 100), 0) / 100);
    const closed = today > end;
    let amount = soFar;
    if (!closed) {
      const budget = m.budget.cats.filter(k => k.cardId === c.id).reduce((t, k) => t + (Number(k.limit) || 0), 0);
      const total = days(start, end), left = today < start ? total : days(today, end) - 1;
      amount = r2(soFar + budget * Math.max(0, left) / total);
    }
    const dueKey = addMonths(key, 1);
    return {
      cardId: c.id, cardName: c.name, billName: c.billName, start, end, soFar, closed, amount,
      dueDate: c.dueDay ? iso(dueKey, c.dueDay) : null,
      incomplete: !months[prevKey] && start < `${key}-01`
    };
  });
}

/**
 * Set each statement card's linked bill in month `key` to its statement amount. Paid bills are left alone (the
 * payment was made). Returns the bills changed. Only cards with a closing day are touched.
 */
export function applyStatementBills(months: Record<string, Month>, key: string, today: string): string[] {
  const m = months[key];
  if (!m) return [];
  const changed: string[] = [];
  for (const s of statementsFor(months, key, today)) {
    if (!s.billName) continue;
    const b = m.bills.find(x => x.name.trim().toLowerCase() === s.billName.trim().toLowerCase());
    if (!b || b.paid || Math.round(b.amount * 100) === Math.round(s.amount * 100)) continue;
    b.amount = s.amount;
    changed.push(b.id);
  }
  return changed;
}
