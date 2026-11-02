// Moves months between the planner's document shape (packages/core types) and the normalized tables.
// Writes are diffs: load a month, apply an op with the core, then save only the rows that changed.
import {
  cardOnlyMonth, cardOnlyMonthsNeeded, clone, expenseFingerprint, guessCat, learnCategories, normalizeMonth, type CategoryMemory, type PendingCharge,
  type Account, type Bill, type Transfer, type BudgetCard, type BudgetCategory, type CardExpense, type Heloc, type HelocDraw, type Loan, type Month
} from '@optimystic/core';
import type { Tx } from './db.js';

type Kind = 'text' | 'num' | 'bool' | 'json' | 'int' | 'nullText' | 'date';
interface Field { f: string; col: string; kind: Kind }
interface ListTable { table: string; keyCol: string; fields: Field[]; get: (m: Month) => Array<{ id: string; version?: number }>; set: (m: Month, rows: unknown[]) => void }

const F = (f: string, col: string, kind: Kind): Field => ({ f, col, kind });

export const LISTS: ListTable[] = [
  {
    table: 'accounts', keyCol: 'account_key',
    fields: [F('name', 'name', 'text'), F('balance', 'balance', 'num'), F('deposit', 'monthly_deposit', 'num'), F('color', 'color', 'text')],
    get: m => m.accounts, set: (m, r) => { m.accounts = r as Account[]; }
  },
  {
    table: 'bills', keyCol: 'id',
    fields: [F('name', 'name', 'text'), F('amount', 'amount', 'num'), F('accountId', 'account_key', 'nullText'), F('recurring', 'recurring', 'bool'),
      F('dueDay', 'due_day', 'int'), F('paid', 'paid', 'bool'), F('loanApplied', 'loan_applied', 'json'), F('helocApplied', 'heloc_applied', 'json')],
    get: m => m.bills, set: (m, r) => { m.bills = r as Bill[]; }
  },
  {
    table: 'transfers', keyCol: 'id',
    fields: [F('fromId', 'from_key', 'text'), F('toId', 'to_key', 'text'), F('amount', 'amount', 'num'), F('note', 'note', 'text'),
      F('recurring', 'recurring', 'bool'), F('done', 'done', 'bool')],
    get: m => m.transfers, set: (m, r) => { m.transfers = r as Transfer[]; }
  },
  {
    table: 'loans', keyCol: 'loan_key',
    fields: [F('kind', 'kind', 'text'), F('name', 'name', 'text'), F('lender', 'lender', 'text'), F('balance', 'balance', 'num'), F('rate', 'apr', 'num'),
      F('payment', 'payment', 'num'), F('escrow', 'escrow', 'num'), F('original', 'original', 'num'), F('open', 'opened', 'text'), F('term', 'term_months', 'num'),
      F('vin', 'vin', 'text'), F('purchasePrice', 'purchase_price', 'num'), F('value', 'value', 'num'), F('valueAsOf', 'value_as_of', 'text'),
      F('valueRate', 'value_change_pct', 'num'), F('valueEstimated', 'value_estimated', 'bool'), F('billName', 'bill_name', 'text'), F('customPmt', 'custom_payment', 'num')],
    get: m => m.loans, set: (m, r) => { m.loans = r as Loan[]; }
  },
  {
    table: 'heloc_draws', keyCol: 'id',
    fields: [F('acctId', 'account_key', 'text'), F('amount', 'amount', 'num')],
    get: m => m.heloc.draws, set: (m, r) => { m.heloc.draws = r as HelocDraw[]; }
  },
  {
    table: 'budget_cards', keyCol: 'card_key',
    fields: [F('name', 'name', 'text'), F('billName', 'bill_name', 'text'), F('color', 'color', 'text'), F('closeDay', 'close_day', 'int'), F('dueDay', 'due_day', 'int')],
    get: m => m.budget.cards, set: (m, r) => { m.budget.cards = r as BudgetCard[]; }
  },
  {
    table: 'budget_categories', keyCol: 'cat_key',
    fields: [F('name', 'name', 'text'), F('limit', 'monthly_limit', 'num'), F('cardId', 'card_key', 'text')],
    get: m => m.budget.cats, set: (m, r) => { m.budget.cats = r as BudgetCategory[]; }
  },
  {
    table: 'card_expenses', keyCol: 'id',
    fields: [F('date', 'date', 'date'), F('desc', 'description', 'text'), F('amount', 'amount', 'num'), F('catId', 'cat_key', 'text'),
      F('cardId', 'card_key', 'text'), F('source', 'source', 'text'), F('catChosen', 'cat_chosen', 'bool'), F('externalId', 'external_id', 'nullText')],
    get: m => m.budget.expenses, set: (m, r) => { m.budget.expenses = r as CardExpense[]; }
  }
];

const HELOC_FIELDS: Field[] = [F('limit', 'credit_limit', 'num'), F('rate', 'apr', 'num'), F('start', 'opened', 'text'), F('drawYears', 'draw_years', 'num'),
  F('repayYears', 'repay_years', 'num'), F('balance', 'balance', 'num'), F('available', 'available', 'num'), F('ytdInterest', 'ytd_interest', 'num'),
  F('customPmt', 'custom_payment', 'num')];

const toDb = (v: unknown, k: Kind): unknown => {
  switch (k) {
    case 'num': return Number(v) || 0;
    case 'int': return v === null || v === undefined || v === '' ? null : Math.round(Number(v)) || null;
    case 'bool': return !!v;
    case 'json': return v ? JSON.stringify(v) : null;
    case 'nullText': return v ? String(v) : null;
    case 'text': return v === null || v === undefined ? '' : String(v);
    case 'date': return String(v);
  }
};
const fromDb = (v: unknown, k: Kind): unknown => {
  switch (k) {
    case 'num': return v === null ? 0 : Number(v);
    case 'int': return v === null ? null : Number(v);
    case 'bool': return !!v;
    case 'json': return v ?? null;
    case 'nullText': return v ?? null;
    case 'text': return v ?? '';
    case 'date': return String(v);
  }
};
/** What a row's fields look like in storage, for change detection and the audit log. */
const canonical = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
    : v;
const snapshot = (row: Record<string, unknown>, fields: Field[]) =>
  Object.fromEntries(fields.map(x => [x.f, x.kind === 'json' ? canonical(row[x.f] ?? null) : fromDb(toDb(row[x.f], x.kind) ?? null, x.kind)]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const meta = (r: Record<string, unknown>) => ({ version: Number(r.version), updatedAt: new Date(r.updated_at as string).toISOString(), updatedBy: (r.updated_by_name as string) ?? null });

export async function monthExists(c: Tx, key: string): Promise<boolean> {
  return (await c.query('SELECT 1 FROM months WHERE key = $1', [key])).rowCount === 1;
}

export async function listMonths(c: Tx | { query: Tx['query'] }): Promise<string[]> {
  return (await c.query('SELECT key FROM months ORDER BY key')).rows.map(r => r.key as string);
}

/** Lock months for the rest of the transaction so two phones' writes to one month queue up instead of interleaving. */
export async function lockMonths(c: Tx, keys: string[]): Promise<void> {
  for (const k of [...new Set(keys)].sort()) await c.query('SELECT key FROM months WHERE key = $1 FOR UPDATE', [k]);
}

/** Load one month as a planner document, with each row's version. Undefined if it doesn't exist. */
export async function loadMonth(c: Tx | { query: Tx['query'] }, key: string): Promise<Month | undefined> {
  const mr = await c.query('SELECT m.*, u.name AS updated_by_name FROM months m LEFT JOIN users u ON u.id = m.updated_by WHERE key = $1', [key]);
  if (!mr.rowCount) return undefined;
  const m: Month = normalizeMonth({}, key);
  m.meta = meta(mr.rows[0]);
  if (mr.rows[0].card_only) m.cardOnly = true;
  m.budget.baseline = Number(mr.rows[0].baseline);
  for (const t of LISTS) {
    const rows = (await c.query(
      `SELECT t.*, u.name AS updated_by_name FROM ${t.table} t LEFT JOIN users u ON u.id = t.updated_by WHERE month_key = $1 ORDER BY sort`, [key])).rows;
    t.set(m, rows.map(r => ({ id: r[t.keyCol], ...Object.fromEntries(t.fields.map(x => [x.f, fromDb(r[x.col], x.kind)])), ...meta(r) })));
  }
  const hr = await c.query('SELECT h.*, u.name AS updated_by_name FROM heloc h LEFT JOIN users u ON u.id = h.updated_by WHERE month_key = $1', [key]);
  if (hr.rowCount) {
    const r = hr.rows[0];
    Object.assign(m.heloc, Object.fromEntries(HELOC_FIELDS.map(x => [x.f, fromDb(r[x.col], x.kind)])), meta(r));
  }
  // Same normalized shape a backup reads into (e.g. every bill has balanceApplied: null).
  const out = normalizeMonth(m, key);
  out.meta = m.meta;
  return out;
}

interface AuditRow { table: string; month: string; row: string; action: string; before: unknown; after: unknown }

async function audit(c: Tx, userId: number | null, rows: AuditRow[]) {
  for (const a of rows) {
    await c.query('INSERT INTO audit_log (user_id, table_name, month_key, row_key, action, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, a.table, a.month, a.row, a.action, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after)]);
  }
}

/**
 * Save the difference between `before` (as loaded) and `after` (after the core applied an op).
 * Changed rows get version + 1; new rows start at 1; removed rows are deleted. Every change is audited.
 * Returns how many rows changed.
 */
export async function saveMonth(c: Tx, key: string, before: Month, after: Month, userId: number | null, action = 'edit'): Promise<number> {
  const log: AuditRow[] = [];
  for (const t of LISTS) {
    const old = new Map(t.get(before).map(r => [r.id, r as unknown as Record<string, unknown>]));
    const now = t.get(after) as unknown as Array<Record<string, unknown> & { id: string }>;
    const keep = new Set(now.map(r => r.id));
    for (const [id, r] of old) {
      if (keep.has(id)) continue;
      await c.query(`DELETE FROM ${t.table} WHERE month_key = $1 AND ${t.keyCol} = $2`, [key, id]);
      log.push({ table: t.table, month: key, row: id, action: 'delete', before: snapshot(r, t.fields), after: undefined });
    }
    for (const r of now) {
      const o = old.get(r.id);
      const snap = snapshot(r, t.fields);
      const extraCols: string[] = [], extraVals: unknown[] = [];
      if (t.table === 'card_expenses') { extraCols.push('import_fingerprint'); extraVals.push(r.source === 'manual' ? null : expenseFingerprint(r as unknown as CardExpense)); }
      if (!o) {
        const cols = ['month_key', t.keyCol, ...t.fields.map(x => x.col), ...extraCols, 'updated_by'];
        if (t.table === 'heloc_draws') cols.push('created_by');
        const vals = [key, r.id, ...t.fields.map(x => toDb(r[x.f], x.kind)), ...extraVals, userId];
        if (t.table === 'heloc_draws') vals.push(userId);
        await c.query(`INSERT INTO ${t.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
        log.push({ table: t.table, month: key, row: r.id, action: 'insert', before: undefined, after: snap });
      } else {
        const prev = snapshot(o, t.fields);
        if (same(prev, snap)) continue;
        const sets = [...t.fields.map(x => x.col), ...extraCols];
        const vals = [...t.fields.map(x => toDb(r[x.f], x.kind)), ...extraVals];
        await c.query(
          `UPDATE ${t.table} SET ${sets.map((col, i) => `${col} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${sets.length + 3}
           WHERE month_key = $1 AND ${t.keyCol} = $2`, [key, r.id, ...vals, userId]);
        log.push({ table: t.table, month: key, row: r.id, action: 'update', before: prev, after: snap });
      }
    }
  }
  // HELOC (one row per month)
  const hp = snapshot(before.heloc as unknown as Record<string, unknown>, HELOC_FIELDS), hn = snapshot(after.heloc as unknown as Record<string, unknown>, HELOC_FIELDS);
  if (!same(hp, hn)) {
    await c.query(
      `UPDATE heloc SET ${HELOC_FIELDS.map((x, i) => `${x.col} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${HELOC_FIELDS.length + 2}
       WHERE month_key = $1`, [key, ...HELOC_FIELDS.map(x => toDb((after.heloc as unknown as Record<string, unknown>)[x.f], x.kind)), userId]);
    log.push({ table: 'heloc', month: key, row: 'heloc', action: 'update', before: hp, after: hn });
  }
  if (Number(before.budget.baseline) !== Number(after.budget.baseline)) {
    await c.query('UPDATE months SET baseline = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE key = $1', [key, after.budget.baseline, userId]);
    log.push({ table: 'months', month: key, row: key, action: 'update', before: { baseline: before.budget.baseline }, after: { baseline: after.budget.baseline } });
  }
  await audit(c, userId, log.map(l => ({ ...l, action: l.action === 'update' || action === 'edit' ? l.action : `${action}:${l.action}` })));
  return log.length;
}

/** Create (or replace) a month from a planner document. */
export async function createMonth(c: Tx, key: string, m: Month, userId: number | null, copiedFrom: string | null, action = 'create'): Promise<void> {
  await c.query('DELETE FROM months WHERE key = $1', [key]);
  await c.query('INSERT INTO months (key, copied_from, created_by, baseline, updated_by, card_only) VALUES ($1, $2, $3, $4, $3, $5)', [key, copiedFrom, userId, Number(m.budget.baseline) || 0, !!m.cardOnly]);
  await c.query('INSERT INTO heloc (month_key, updated_by) VALUES ($1, $2)', [key, userId]);
  const empty = normalizeMonth({}, key);
  empty.budget = { baseline: m.budget.baseline, cards: [], cats: [], expenses: [] };
  // The HELOC row exists with defaults; save the rest as a diff from an empty month.
  const blank: Month = { ...clone(empty), heloc: { ...clone(empty.heloc), ...Object.fromEntries(HELOC_FIELDS.map(x => [x.f, undefined])), draws: [] } as unknown as Heloc };
  const fresh = clone(m);
  await saveMonth(c, key, blank, fresh, userId, action);
}

export async function deleteMonth(c: Tx, key: string, userId: number | null): Promise<boolean> {
  const r = await c.query('DELETE FROM months WHERE key = $1', [key]);
  if (r.rowCount) await audit(c, userId, [{ table: 'months', month: key, row: key, action: 'delete', before: { key }, after: undefined }]);
  return !!r.rowCount;
}

export async function auditNote(c: Tx, userId: number | null, action: string, after: unknown, month: string | null = null) {
  await audit(c, userId, [{ table: 'months', month: month as string, row: month as string, action, before: undefined, after }]);
}

/** The household's category memory: every expense a person filed, oldest first, across all months. */
export async function categoryMemory(c: Tx | { query: Tx['query'] }): Promise<CategoryMemory> {
  const r = await c.query(`SELECT e.description, e.cat_key, coalesce(k.name, '') AS cat_name
    FROM card_expenses e LEFT JOIN budget_categories k ON k.month_key = e.month_key AND k.cat_key = e.cat_key
    WHERE e.cat_chosen ORDER BY e.updated_at, e.date, e.sort`);
  return learnCategories(r.rows.map(x => ({ desc: x.description as string, catId: x.cat_key as string, catName: x.cat_name as string })));
}

/** Pending card charges from the latest sync dated in this month, each with a guessed category. */
export async function pendingCharges(c: Tx | { query: Tx['query'] }, key: string, month?: Month): Promise<PendingCharge[]> {
  const r = await c.query(`SELECT id, card_key, to_char(date, 'YYYY-MM-DD') AS date, description, amount FROM card_pending
    WHERE to_char(date, 'YYYY-MM') = $1 ORDER BY date DESC, description`, [key]);
  if (!r.rowCount) return [];
  const m = month || await loadMonth(c, key);
  const memory = await categoryMemory(c);
  return r.rows.map(x => ({ id: x.id as string, cardId: x.card_key as string, date: x.date as string, desc: x.description as string, amount: Number(x.amount),
    catId: m ? guessCat(x.description as string, m.budget, memory)?.id : undefined }));
}

export async function cardOnlyKeys(c: Tx | { query: Tx['query'] }): Promise<string[]> {
  return (await c.query('SELECT key FROM months WHERE card_only ORDER BY key')).rows.map(r => r.key as string);
}

/**
 * Make card-only months for every missing month from `fromKey` up to the planner's first month, so older card
 * charges have somewhere to go. They copy the first month's cards and categories. Returns the months created.
 */
export async function ensureCardOnlyMonths(c: Tx, fromKey: string, userId: number | null): Promise<string[]> {
  const all = (await c.query('SELECT key FROM months ORDER BY key')).rows.map(r => r.key as string);
  if (!all.length || fromKey >= all[0]) return [];
  const need = cardOnlyMonthsNeeded(fromKey, all[0], all);
  const template = (await loadMonth(c, all[0]))!;
  for (const k of need) await createMonth(c, k, cardOnlyMonth(template), userId, null, 'card-only');
  return need;
}
