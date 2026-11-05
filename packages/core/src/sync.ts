// Card sync (SimpleFIN): turn a card's transactions into card expenses without counting anything twice.
import type { CardExpense, Month } from './types.js';
import { r2 } from './money.js';
import { monthLabel } from './dates.js';
import { cleanDesc, guessCat, merchantKey, type CategoryMemory } from './budget.js';
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

/** A charge still flagged pending this many days after its posting date is treated as posted. */
export const STALE_PENDING_DAYS = 3;

/**
 * Pending charges that have already posted: the bank sometimes keeps the pending entry in the feed after the posted
 * one arrives under a new id. A pending charge is settled by a posted charge (or one already in the planner) on the
 * same card for the same amount at the same store within 7 days; each posted charge settles at most one.
 */
export function unsettledPending(pending: SyncItem[], posted: Array<{ date: string; desc: string; amount: number }>): SyncItem[] {
  const used = new Set<number>();
  return pending.filter(p => {
    const k = merchantKey(p.desc);
    const i = posted.findIndex((x, j) => !used.has(j) && Math.round(x.amount * 100) === Math.round(p.amount * 100)
      && dayDiff(x.date, p.date) <= 7 && (x.desc === p.desc || merchantKey(x.desc) === k));
    if (i < 0) return true;
    used.add(i);
    return false;
  });
}

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
export function cardItems(txns: SfTransaction[], tz?: string, now = Date.now() / 1000):
  { items: SyncItem[]; pending: number; payments: number; pendingItems: SyncItem[] } {
  let payments = 0;
  const items: SyncItem[] = [], pendingItems: SyncItem[] = [];
  for (const t of txns) {
    const raw = Number(t.amount) || 0;
    const desc = cleanDesc(String(t.description || t.payee || ''));
    if (!raw || !desc) continue;
    if (PAY.test(desc) || (raw > 0 && /\bPAYMENT\b/i.test(desc))) { if (!(t.pending || !t.posted)) payments++; continue; }
    const item = { id: String(t.id), date: isoInZone(t.transacted_at || t.posted || now, tz), desc, amount: r2(-raw) };
    // Pending charges are shown but not filed: their id and amount often change when they post. Some banks (BoA
    // through MX) leave the pending flag on after a charge has posted; a posting date over 3 days old wins.
    const stalePendingFlag = t.pending && t.posted > 0 && now - t.posted > STALE_PENDING_DAYS * 86400;
    if ((t.pending && !stalePendingFlag) || !t.posted) pendingItems.push(item); else items.push(item);
  }
  return { items, pending: pendingItems.length, payments, pendingItems };
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;

export interface SyncResult {
  added: number; matched: number; already: number;
  /** Dated in a month the planner doesn't have, after its first month (a gap, or a month not started yet). */
  skipped: number;
  /** Dated before the planner's first month: older than anything tracked, so left out quietly. */
  older?: number;
  months: string[];
}

/**
 * File synced items. A transaction already synced (same bank id) is left alone. One already brought in by CSV
 * import or typed in is matched instead of added: same card, same amount, same store, dated within 5 days, and
 * not yet matched to another transaction, so two identical real charges still stay two. Lines dated in a month
 * the planner doesn't have are skipped and counted.
 */
export function importSynced(months: Record<string, Month>, items: SyncItem[], cardId: string, template: Month | undefined,
  newId: () => string = uid, memory?: CategoryMemory, firstMonth?: string): SyncResult {
  const all = () => Object.values(months).flatMap(m => m.budget.expenses);
  let added = 0, matched = 0, already = 0, skipped = 0, older = 0;
  const touched = new Set<string>();
  const first = firstMonth || Object.keys(months).sort()[0];
  for (const i of items) {
    if (all().some(e => e.externalId === i.id)) { already++; continue; }
    const m = months[i.date.slice(0, 7)];
    if (!m) { if (first && i.date.slice(0, 7) < first) older++; else skipped++; continue; }
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
  return { added, matched, already, skipped, older, months: [...touched].sort() };
}

export const syncMessage = (r: SyncResult) =>
  (r.added ? `Added ${r.added} charge${r.added === 1 ? '' : 's'}${r.months.length ? ' to ' + r.months.map(monthLabel).join(', ') : ''}.` : 'No new charges.')
  + (r.matched ? ` ${r.matched} already imported by CSV.` : '')
  + (r.skipped ? ` ${r.skipped} skipped (no planner month for their date; start that month to bring them in).` : '')
  + (r.older ? ` ${r.older} older charge${r.older === 1 ? '' : 's'} from before the planner’s first month left out.` : '');

/** A pending card charge as the planner shows it: with a guessed category, not yet filed. */
export interface PendingCharge { id: string; cardId: string; date: string; desc: string; amount: number; catId?: string; catChosen?: boolean }

/**
 * A copy of a month with its pending charges added as if they'd posted. Used wherever pending charges should
 * count: the spend bars, left to spend, over-budget alerts and projected card bills. Never saved.
 */
export function withPending(m: Month, pending: PendingCharge[], key?: string): Month {
  const out = clone(m);
  for (const p of pending) {
    if (key && p.date.slice(0, 7) !== key) continue;
    out.budget.expenses.push({ id: 'pending-' + p.id, date: p.date, desc: p.desc, amount: p.amount, catId: p.catId || '', cardId: p.cardId, source: 'sync', catChosen: false });
  }
  return out;
}
