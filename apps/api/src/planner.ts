import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PlannerError, applyOp, budgetStats, buildNewMonth, clone, helocCalc, importCardItems, isMonthKey, monthTotals, parseCardCSV,
  readBackup, shortfalls, stateCheck, targetVersion, toBackup, todayISO, uid, BackupError,
  type BalanceMode, type CardBillMode, type Month, type Op, type PlannerState, addMonths, applyStatementBills, statementsFor, withPending
} from '@optimystic/core';
import { tx, type Db, type Tx } from './db.js';
import type { Config } from './config.js';
import { requireUser, type User } from './auth.js';
import { auditNote, categoryMemory, createMonth, pendingCharges, deleteMonth, listMonths, loadMonth, lockMonths, saveMonth } from './repo.js';

/** Just enough for the app's banner and the Card budget line. */
async function syncSummary(c: Tx | Db) {
  const r = (await c.query('SELECT last_sync_at, last_error FROM bank_connections ORDER BY id DESC LIMIT 1')).rows[0];
  return r ? { connected: true, lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null, lastError: r.last_error as string | null } : { connected: false, lastSyncAt: null, lastError: null };
}

async function statementsOf(c: Tx | Db, key: string, month: Month) {
  if (!month.budget.cards.some(x => x.closeDay)) return [];
  return statementsFor(await withNeighbourPending(c, key, month), key, todayISO(TZ));
}

/** This month and the month before, each with its pending card charges counted (for statements and their bills). */
async function withNeighbourPending(c: Tx | Db, key: string, month: Month): Promise<Record<string, Month>> {
  const prevKey = addMonths(key, -1), prev = await loadMonth(c, prevKey);
  const months: Record<string, Month> = { [key]: withPending(month, await pendingCharges(c, key, month), key) };
  if (prev) months[prevKey] = withPending(prev, await pendingCharges(c, prevKey, prev), prevKey);
  return months;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

/** The answer to every month read and write: the month, its totals, and the month list, so a screen redraws from one reply. */
let TZ = 'America/Chicago';

/**
 * Card bills that follow their statements: set each one (unpaid) in these months to its statement amount.
 * Call after anything that can change a statement: expenses, card settings, a sync or import, a new month.
 */
export async function refreshStatementBills(c: Tx, keys: string[], userId: number | null): Promise<void> {
  const today = todayISO(TZ);
  for (const key of [...new Set(keys)].sort()) {
    const before = await loadMonth(c, key);
    if (!before || !before.budget.cards.some(x => x.closeDay)) continue;
    // Pending charges count in a projected statement; the bills are set on the real month, never the copy.
    const shown = await withNeighbourPending(c, key, before);
    if (!applyStatementBills(shown, key, today).length) continue;
    const after = clone(before);
    shown[key].bills.forEach(b => { const x = after.bills.find(y => y.id === b.id); if (x) x.amount = b.amount; });
    await saveMonth(c, key, before, after, userId, 'statement');
  }
}

export async function monthPayload(c: Tx | Db, key: string, m?: Month) {
  const month = m || await loadMonth(c, key);
  if (!month) throw new HttpError(404, `There’s no ${key} in the planner.`);
  const h = helocCalc(month, key);
  return {
    key,
    months: await listMonths(c),
    month,
    totals: monthTotals(month),
    budget: budgetStats(month),
    heloc: { thisMonth: h.thisMonth, io: h.io, repayPmt: h.repayPmt, shortfall: shortfalls(month).reduce((t, x) => t + x.need, 0) },
    catMemory: await categoryMemory(c),
    sync: await syncSummary(c),
    pending: month ? await pendingCharges(c, key, month) : [],
    statements: month ? await statementsOf(c, key, month) : []
  };
}

const keyParam = (req: FastifyRequest) => {
  const key = (req.params as { key: string }).key;
  if (!isMonthKey(key)) throw new HttpError(400, 'Months look like 2026-11.');
  return key;
};

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, ...e.extra });
  if (e instanceof PlannerError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof BackupError || e instanceof SyntaxError) return reply.code(400).send({ error: e.message });
  throw e;
}

export function registerPlanner(app: FastifyInstance, db: Db, cfg: Config) {
  TZ = cfg.tz;
  /** Run ops against one month inside a transaction, with the version check (409 when someone else got there first). */
  async function runOps(user: User, key: string, ops: Op[]) {
    return tx(db, async c => {
      await lockMonths(c, [key]);
      const before = await loadMonth(c, key);
      if (!before) throw new HttpError(404, `There’s no ${key} in the planner.`);
      const after = clone(before);
      for (const op of ops) {
        if (!op || typeof op !== 'object' || typeof op.type !== 'string') throw new HttpError(400, 'Bad change.');
        if ('version' in op && op.version !== undefined && op.version !== null) {
          const current = targetVersion(after, op);
          if (current !== undefined && current !== Number(op.version)) {
            throw new HttpError(409, 'Someone else changed this first. Here’s the latest.', { conflict: true });
          }
        }
        applyOp(after, key, op);
      }
      await saveMonth(c, key, before, after, user.id);
      // Expenses and card settings feed the statements this month's and next month's card bills come from.
      if (ops.some(o => /^(expense|card)\./.test(o.type))) await refreshStatementBills(c, [key, addMonths(key, 1)], user.id);
      return monthPayload(c, key);
    });
  }

  /** Shared wrapper: sign-in, month key, errors, and a 409 that carries the latest month. */
  function opRoute(build: (req: FastifyRequest, key: string) => Op | Op[], code = 200) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const user = requireUser(req, reply); if (!user) return;
      try {
        const key = keyParam(req);
        const built = build(req, key);
        const out = await runOps(user, key, Array.isArray(built) ? built : [built]);
        return reply.code(code).send(out);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          const key = (req.params as { key: string }).key;
          const latest = await monthPayload(db, key).catch(() => null);
          return reply.code(409).send({ error: e.message, conflict: true, latest });
        }
        return sendError(reply, e);
      }
    };
  }

  const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  const version = (req: FastifyRequest) => {
    const v = body(req).version ?? (req.query as Record<string, string>)?.version;
    return v === undefined || v === null || v === '' ? undefined : Number(v);
  };
  const patchOf = (req: FastifyRequest) => { const { version: _, id: __, ...p } = body(req); return p; };

  /* ---------- months ---------- */
  app.get('/api/months', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { months: await listMonths(db), today: todayISO(cfg.tz) };
  });

  app.get('/api/months/:key', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    try { return await monthPayload(db, keyParam(req)); } catch (e) { return sendError(reply, e); }
  });

  // Rule 9: a new month copies another one.
  app.post('/api/months', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const b = body(req);
    const key = String(b.key || ''), from = String(b.from || '');
    const balances = (['forecast', 'same', 'zero'].includes(String(b.balances)) ? b.balances : 'forecast') as BalanceMode;
    const cardBills = (['projected', 'actual', 'keep'].includes(String(b.cardBills)) ? b.cardBills : 'projected') as CardBillMode;
    try {
      if (!isMonthKey(key)) throw new HttpError(400, 'Months look like 2026-11.');
      const out = await tx(db, async c => {
        const existing = await listMonths(c);
        if (existing.includes(key) && b.replace && user.role !== 'owner') throw new HttpError(403, 'Only the owner can replace a month.');
        if (existing.includes(key) && !b.replace) throw new HttpError(409, `${key} already exists. Replace it with a copy?`, { exists: true });
        let m: Month;
        if (from) {
          await lockMonths(c, [from]);
          const src = await loadMonth(c, from);
          if (!src) throw new HttpError(404, `There’s no ${from} to copy.`);
          m = buildNewMonth(src, { balances, cardBills, copyOneTime: !!b.copyOneTime });
        } else {
          if (existing.length) throw new HttpError(400, 'Choose a month to copy from.');
          m = readBackup({ current: key, months: { [key]: {} } }).months[key];
        }
        await createMonth(c, key, m, user.id, from || null);
        await refreshStatementBills(c, [key], user.id);
        return monthPayload(c, key);
      });
      return reply.code(201).send(out);
    } catch (e) { return sendError(reply, e); }
  });

  app.delete('/api/months/:key', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can delete a month.' });
    try {
      const key = keyParam(req);
      return await tx(db, async c => {
        const all = await listMonths(c);
        if (!all.includes(key)) throw new HttpError(404, `There’s no ${key} in the planner.`);
        if (all.length <= 1) throw new HttpError(400, 'Keep at least one month.');
        await deleteMonth(c, key, user.id);
        return { months: await listMonths(c) };
      });
    } catch (e) { return sendError(reply, e); }
  });

  /** Any op, or a list of ops, in one request. The web app uses this (including for edits made offline). */
  app.post('/api/months/:key/ops', opRoute(req => {
    const b = req.body as Op | Op[] | { ops: Op[] };
    if (Array.isArray(b)) return b;
    if (b && 'ops' in b && Array.isArray(b.ops)) return b.ops;
    return b as Op;
  }));

  /* ---------- accounts ---------- */
  app.post('/api/months/:key/accounts', opRoute(req => {
    const b = body(req);
    return { type: 'account.add', id: String(b.id || uid()), name: String(b.name ?? ''), balance: b.balance as number, deposit: b.deposit as number, color: b.color as string };
  }, 201));
  app.patch('/api/months/:key/accounts/:id', opRoute(req => ({ type: 'account.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/accounts/:id', opRoute(req => ({ type: 'account.remove', id: id(req), version: version(req) })));

  /* ---------- bills ---------- */
  app.post('/api/months/:key/bills', opRoute(req => {
    const b = body(req);
    return { type: 'bill.add', id: String(b.id || uid()), name: String(b.name ?? ''), amount: b.amount as number, accountId: (b.accountId as string) ?? null,
      dueDay: b.dueDay as number, recurring: b.recurring !== false };
  }, 201));
  app.patch('/api/months/:key/bills/:id', opRoute(req => ({ type: 'bill.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/bills/:id', opRoute(req => ({ type: 'bill.remove', id: id(req), version: version(req) })));

  /* ---------- transfers between accounts ---------- */
  app.post('/api/months/:key/transfers', opRoute(req => {
    const b = body(req);
    return { type: 'transfer.add', id: String(b.id || uid()), fromId: String(b.fromId ?? ''), toId: String(b.toId ?? ''), amount: b.amount as number,
      note: b.note as string, recurring: !!b.recurring };
  }, 201));
  app.patch('/api/months/:key/transfers/:id', opRoute(req => ({ type: 'transfer.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/transfers/:id', opRoute(req => ({ type: 'transfer.remove', id: id(req), version: version(req) })));

  /* ---------- loans and HELOC ---------- */
  app.post('/api/months/:key/loans', opRoute(req => ({ type: 'loan.add', id: String(body(req).id || uid()) }), 201));
  app.patch('/api/months/:key/loans/:id', opRoute(req => ({ type: 'loan.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/loans/:id', opRoute(req => ({ type: 'loan.remove', id: id(req), version: version(req) })));
  app.post('/api/months/:key/loans/:id/match-bill', opRoute(req => ({ type: 'loan.matchBill', id: id(req) })));
  app.patch('/api/months/:key/heloc', opRoute(req => ({ type: 'heloc.update', version: version(req), patch: patchOf(req) })));
  app.post('/api/months/:key/heloc/bill', opRoute(req => ({ type: 'heloc.setBill', amount: body(req).amount as number, billId: String(body(req).billId || uid()) })));
  app.post('/api/months/:key/heloc/draws', opRoute(req => {
    const b = body(req);
    return { type: 'heloc.draw', id: String(b.id || uid()), acctId: String(b.acctId ?? b.accountId ?? ''), amount: b.amount as number };
  }, 201));
  app.delete('/api/months/:key/heloc/draws/:id', opRoute(req => ({ type: 'heloc.undoDraw', id: id(req) })));
  app.post('/api/months/:key/heloc/cover-shortfalls', opRoute(req => {
    const b = body(req);
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : Array.from({ length: 50 }, () => uid());
    return { type: 'heloc.cover', acctId: (b.acctId as string) || undefined, ids };
  }));

  /* ---------- card budget ---------- */
  app.patch('/api/months/:key/budget', opRoute(req => ({ type: 'budget.update', version: version(req), patch: patchOf(req) })));
  app.post('/api/months/:key/budget/cards', opRoute(req => ({ type: 'card.add', id: String(body(req).id || 'card-' + uid()), name: body(req).name as string }), 201));
  app.patch('/api/months/:key/budget/cards/:id', opRoute(req => ({ type: 'card.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/budget/cards/:id', opRoute(req => ({ type: 'card.remove', id: id(req), version: version(req) })));
  app.post('/api/months/:key/budget/categories', opRoute(req => {
    const b = body(req);
    return { type: 'cat.add', id: String(b.id || 'cat-' + uid()), name: b.name as string, limit: b.limit as number, cardId: b.cardId as string };
  }, 201));
  app.patch('/api/months/:key/budget/categories/:id', opRoute(req => ({ type: 'cat.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/budget/categories/:id', opRoute(req => ({ type: 'cat.remove', id: id(req), version: version(req) })));
  app.post('/api/months/:key/budget/expenses', opRoute(req => {
    const b = body(req);
    return { type: 'expense.add', id: String(b.id || uid()), date: String(b.date ?? ''), desc: String(b.desc ?? b.description ?? ''), amount: b.amount as number,
      catId: String(b.catId ?? ''), cardId: String(b.cardId ?? '') };
  }, 201));
  app.patch('/api/months/:key/budget/expenses/:id', opRoute(req => ({ type: 'expense.update', id: id(req), version: version(req), patch: patchOf(req) })));
  app.delete('/api/months/:key/budget/expenses/:id', opRoute(req => ({ type: 'expense.remove', id: id(req), version: version(req) })));

  // Rule 12: a card CSV, filed by the month of each line's date across every month it touches.
  app.post('/api/budget/import', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const b = body(req);
    const card = String(b.card ?? b.cardKey ?? ''), csv = String(b.csv ?? ''), current = String(b.month ?? '');
    try {
      if (!card) throw new HttpError(400, 'Choose which card the file is from.');
      const parsed = parseCardCSV(csv);
      if (!parsed.ok) throw new HttpError(422, parsed.error);
      return await tx(db, async c => {
        const all = await listMonths(c);
        const touched = [...new Set(parsed.items.map(i => i.date.slice(0, 7)))].filter(k => all.includes(k));
        const tmplKey = all.includes(current) ? current : all[all.length - 1];
        await lockMonths(c, [...touched, tmplKey].filter(Boolean));
        const before: Record<string, Month> = {};
        for (const k of touched) before[k] = (await loadMonth(c, k))!;
        const template = tmplKey ? (before[tmplKey] || await loadMonth(c, tmplKey)) : undefined;
        if (template && !template.budget.cards.some(x => x.id === card) && !touched.some(k => before[k].budget.cards.some(x => x.id === card)))
          throw new HttpError(404, 'That card isn’t in the planner.');
        const after: Record<string, Month> = clone(before);
        const result = importCardItems(after, parsed.items, card, template, undefined, await categoryMemory(c));
        for (const k of touched) await saveMonth(c, k, before[k], after[k], user.id, 'csv-import');
        await refreshStatementBills(c, touched.flatMap(k => [k, addMonths(k, 1)]), user.id);
        return { ...result, alreadyLogged: result.dup };
      });
    } catch (e) { return sendError(reply, e); }
  });

  /* ---------- backups ---------- */
  async function loadState(c: Tx | Db): Promise<PlannerState> {
    const keys = await listMonths(c);
    const months: Record<string, Month> = {};
    for (const k of keys) months[k] = (await loadMonth(c, k))!;
    return { current: keys[keys.length - 1] || '', months };
  }

  app.get('/api/export', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const st = toBackup(await loadState(db));
    const q = req.query as Record<string, string>;
    if (q.current && st.months[q.current]) st.current = q.current;
    reply.header('Content-Disposition', `attachment; filename="bill-planner-backup-${todayISO(cfg.tz)}.json"`);
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/json').send(JSON.stringify(st, null, 2));
  });

  // Replaces everything with a backup file, then reports the check figures from the file and from the database.
  app.post('/api/import', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can load a backup.' });
    try {
      const file = readBackup(req.body);
      const fromFile = stateCheck(file);
      const fromDb = await tx(db, async c => {
        await c.query('LOCK TABLE months IN EXCLUSIVE MODE');
        await c.query('DELETE FROM months');
        for (const k of Object.keys(file.months).sort()) await createMonth(c, k, file.months[k], user.id, null, 'import');
        await auditNote(c, user.id, 'import', { months: Object.keys(file.months).sort() });
        return stateCheck(await loadState(c));
      });
      const mismatches = compareChecks(fromFile, fromDb);
      return { current: file.current, months: Object.keys(file.months).sort(), fromFile, fromDb, matches: mismatches.length === 0, mismatches };
    } catch (e) { return sendError(reply, e); }
  });

  app.get('/api/audit', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const limit = Math.min(500, Number((req.query as Record<string, string>).limit) || 100);
    const r = await db.query(`SELECT a.id, a.at, u.name AS user, a.table_name, a.month_key, a.row_key, a.action, a.before, a.after
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`, [limit]);
    return { entries: r.rows };
  });
}

/** Every figure on the import check screen, compared to the cent. */
export function compareChecks(a: ReturnType<typeof stateCheck>, b: ReturnType<typeof stateCheck>): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (typeof x === 'number' || typeof y === 'number') {
      if (Math.round(Number(x) * 100) !== Math.round(Number(y) * 100)) out.push(`${path}: ${x} vs ${y}`);
    } else if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) out.push(`${path}: ${x.length} vs ${y.length} rows`);
      x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
    } else if (x && typeof x === 'object' && y && typeof y === 'object') {
      for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else if (x !== y) out.push(`${path}: ${String(x)} vs ${String(y)}`);
  };
  walk(a, b, '');
  return out;
}
