import type { CardExpense, Month } from './types.js';
import { r2 } from './money.js';
import { monthLabel } from './dates.js';
import { guessCat, type CategoryMemory } from './budget.js';
import { clone, uid } from './ids.js';

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. Blank rows are dropped. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

export interface CsvItem { date: string; desc: string; amount: number }
export type CsvParse = { ok: true; items: CsvItem[] } | { ok: false; error: string };

const PAY = /PAYMENT THANK|PAYMENT - THANK|AUTOPAY|AUTO PAY|PAYMENT FROM|ONLINE PAYMENT|MOBILE PAYMENT|BA ELECTRONIC PAYMENT/i;

/**
 * Rule 12, first half: find the date, description and amount columns (or debit and credit), skip payments,
 * and flip the sign when purchases are negative so purchases come out positive and returns negative.
 */
export function parseCardCSV(text: string): CsvParse {
  const rows = parseCSV(String(text).replace(/^﻿/, ''));
  const hi = rows.findIndex(r => r.some(c => /date/i.test(c)) && r.some(c => /amount|debit/i.test(c)));
  if (hi < 0) return { ok: false, error: 'Couldn’t find Date and Amount columns in that file.' };
  const H = rows[hi].map(h => h.trim().toLowerCase());
  const col = (...res: RegExp[]) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  const cDate = col(/^transaction date$/, /trans.*date/, /^date$/, /posted date|post date/, /date/);
  const cDesc = col(/description/, /payee/, /merchant/, /name/);
  const cAmt = col(/^amount$/, /amount/), cDebit = col(/debit/), cCredit = col(/credit/), cType = col(/^type$/);
  if (cDate < 0 || cDesc < 0 || (cAmt < 0 && cDebit < 0)) return { ok: false, error: 'Couldn’t find Date, Description and Amount columns in that file.' };
  const num = (v: unknown) => parseFloat(String(v || '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')) || 0;
  const isoOf = (v: unknown) => {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    return '';
  };
  const raw: Array<{ date: string; desc: string; raw: number }> = [];
  rows.slice(hi + 1).forEach(r => {
    const date = isoOf(r[cDate]), desc = String(r[cDesc] || '').trim();
    if (!date || !desc) return;
    if ((cType >= 0 && /payment/i.test(r[cType] || '')) || PAY.test(desc)) return;
    const v = cAmt >= 0 ? num(r[cAmt]) : (num(r[cDebit]) ? -Math.abs(num(r[cDebit])) : Math.abs(num(r[cCredit])));
    if (!v) return;
    raw.push({ date, desc, raw: v });
  });
  if (!raw.length) return { ok: false, error: 'No purchases found in that file.' };
  // Most card downloads show purchases as negative numbers; flip them so purchases are positive spending.
  const flip = raw.filter(i => i.raw < 0).length >= raw.filter(i => i.raw > 0).length;
  return { ok: true, items: raw.map(i => ({ date: i.date, desc: i.desc, amount: r2(flip ? -i.raw : i.raw) })) };
}

export const expenseFingerprint = (e: { date: string; desc: string; amount: number; cardId: string }) =>
  `${e.date}|${e.desc}|${Number(e.amount).toFixed(2)}|${e.cardId}`;

export interface ImportResult { added: number; dup: number; skipped: number; months: string[]; message: string }

/**
 * Rule 12, second half: file each line in the month of its date. A line already logged isn't added again,
 * but two identical real charges stay two (lines are matched by count, not just by presence).
 * Lines dated in a month the planner doesn't have yet are skipped and counted.
 * `months` is changed in place; `template` supplies the card if a month doesn't have it yet.
 */
export function importCardItems(months: Record<string, Month>, items: CsvItem[], cardId: string, template: Month | undefined,
  newId: () => string = uid, memory?: CategoryMemory): ImportResult {
  let added = 0, dup = 0, skipped = 0;
  const touched = new Set<string>();
  const counts: Record<string, number> = {};
  for (const i of items) {
    const key = i.date.slice(0, 7), m = months[key];
    if (!m) { skipped++; continue; }
    const b = m.budget;
    if (!b.cards.some(c => c.id === cardId)) {
      const src = template?.budget.cards.find(c => c.id === cardId);
      if (src) { const c = clone(src); delete c.version; b.cards.push(c); }
    }
    const fp = expenseFingerprint({ ...i, cardId });
    counts[fp] = (counts[fp] || 0) + 1;
    const have = b.expenses.filter(e => e.date === i.date && e.desc === i.desc && Math.abs(Number(e.amount) - i.amount) < 0.005 && e.cardId === cardId).length;
    if (have >= counts[fp]) { dup++; continue; }
    const c = guessCat(i.desc, b, memory);
    const exp: CardExpense = { id: newId(), date: i.date, desc: i.desc, amount: i.amount, catId: c ? c.id : '', cardId, source: 'csv', catChosen: false };
    b.expenses.push(exp);
    added++; touched.add(key);
  }
  const ms = [...touched].sort();
  const message = (added ? `✓ Added ${added} expense${added === 1 ? '' : 's'}${ms.length ? ' to ' + ms.map(monthLabel).join(', ') : ''}.` : 'Nothing new to add.')
    + (dup ? ` ${dup} already logged.` : '') + (skipped ? ` ${skipped} skipped (no planner month for their date — create that month first).` : '');
  return { added, dup, skipped, months: ms, message };
}
