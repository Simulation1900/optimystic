// Card sync (SimpleFIN): turn a card's transactions into card expenses without counting anything twice.
import type { CardExpense, Month } from './types.js';
import { r2 } from './money.js';
import { monthLabel } from './dates.js';
import { guessCat, merchantKey, type CategoryMemory } from './budget.js';
import { PAY } from './csv.js';
import { clone, uid } from './ids.js';

/** One transaction from SimpleFIN's /accounts response (amounts are strings; card purchases are negative). */
export interface SfTransaction {
  id: string;
  posted: number;           // epoch seconds; 0 while pending
  amount: string | number;
  description: string;
  payee?: string;
  memo?: string;
  transacted_at?: number;   // epoch seconds, when the bank provides it
  pending?: boolean;
}

export interface SyncItem { id: string; date: string; desc: string; amount: number }

/** Epoch seconds → 'YYYY-MM-DD' in the household's time zone. */
export const isoInZone = (epoch: number, tz = 'America/Chicago'): string => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(epoch * 1000));
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};

/**
 * Card transactions → items to file. Pending charges wait until they post; payments to the card are skipped;
 * purchases come out positive and returns negative (like the CSV import). Filed by transaction date when the
 * bank gives one (that's what the CSV import uses), else the posting date.
 */
export function cardItems(txns: SfTransaction[], tz?: string): { items: SyncItem[]; pending: number; payments: number } {
  let pending = 0, payments = 0;
  const items: SyncItem[] = [];
  for (const t of txns) {
    if (t.pending || !t.posted) { pending++; continue; }
    const raw = Number(t.amount) || 0;
    const desc = String(t.description || t.payee || '').trim();
    if (!raw || !desc) continue;
    if (PAY.test(desc) || (raw > 0 && /\bPAYMENT\b/i.test(desc))) { payments++; continue; }
    items.push({ id: String(t.id), date: isoInZone(t.transacted_at || t.posted, tz), desc, amount: r2(-raw) });
  }
  return { items, pending, payments };
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;

export interface SyncResult { added: number; matched: number; already: number; skipped: number; months: string[] }

/**
 * File synced items. A transaction already synced (same bank id) is left alone. One already brought in by CSV
 * import or typed in is matched instead of added: same card, same amount, same store, dated within 5 days, and
 * not yet matched to another transaction, so two identical real charges still stay two. Lines dated in a month
 * the planner doesn't have are skipped and counted.
 */
export function importSynced(months: Record<string, Month>, items: SyncItem[], cardId: string, template: Month | undefined,
  newId: () => string = uid, memory?: CategoryMemory): SyncResult {
  const all = () => Object.values(months).flatMap(m => m.budget.expenses);
  let added = 0, matched = 0, already = 0, skipped = 0;
  const touched = new Set<string>();
  for (const i of items) {
    if (all().some(e => e.externalId === i.id)) { already++; continue; }
    const m = months[i.date.slice(0, 7)];
    if (!m) { skipped++; continue; }
    const key = merchantKey(i.desc);
    const twin = all().find(e => !e.externalId && e.cardId === cardId && Math.round(e.amount * 100) === Math.round(i.amount * 100)
      && dayDiff(e.date, i.date) <= 5 && (e.desc === i.desc || merchantKey(e.desc) === key));
    if (twin) { twin.externalId = i.id; matched++; continue; }
    const b = m.budget;
    if (!b.cards.some(c => c.id === cardId)) {
      const src = template?.budget.cards.find(c => c.id === cardId);
      if (src) { const c = clone(src); delete c.version; b.cards.push(c); }
    }
    const c = guessCat(i.desc, b, memory);
    const e: CardExpense = { id: newId(), date: i.date, desc: i.desc, amount: i.amount, catId: c ? c.id : '', cardId, source: 'sync', catChosen: false, externalId: i.id };
    b.expenses.push(e);
    added++; touched.add(i.date.slice(0, 7));
  }
  return { added, matched, already, skipped, months: [...touched].sort() };
}

export const syncMessage = (r: SyncResult) =>
  (r.added ? `Added ${r.added} charge${r.added === 1 ? '' : 's'}${r.months.length ? ' to ' + r.months.map(monthLabel).join(', ') : ''}.` : 'No new charges.')
  + (r.matched ? ` ${r.matched} already imported by CSV.` : '')
  + (r.skipped ? ` ${r.skipped} skipped (no planner month for their date).` : '');
