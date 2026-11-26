// Household money goals: set in a month, carried over until done or dropped, measured from the months themselves.
import type { FastifyInstance } from 'fastify';
import { GOAL_KINDS, goalProgress, isMonthKey, type Goal, type GoalKind, type Month } from '@optimystic/core';
import type { Db, Tx } from './db.js';
import { requireUser } from './auth.js';
import { listMonths, loadMonth } from './repo.js';

type Q = Tx | { query: Tx['query'] };

const row = (r: Record<string, unknown>): Goal => ({
  id: r.id as number, kind: r.kind as GoalKind, title: r.title as string, target: r.target === null ? null : Number(r.target),
  ref: (r.ref as string) ?? null, dueMonth: (r.due_month as string) ?? null, startMonth: r.start_month as string,
  endMonth: (r.end_month as string) ?? null, status: r.status as Goal['status'], notes: (r.notes as string) ?? ''
});

export async function loadGoals(c: Q): Promise<Goal[]> {
  return (await c.query('SELECT * FROM goals ORDER BY status = \'active\' DESC, id')).rows.map(row);
}

export async function allMonths(c: Q): Promise<Array<[string, Month]>> {
  const out: Array<[string, Month]> = [];
  for (const k of await listMonths(c)) { const m = await loadMonth(c, k); if (m) out.push([k, m]); }
  return out;
}

/** Goals with their month-by-month progress, as the Advice tab and the brief show them. */
export async function goalsWithProgress(c: Q, months?: Array<[string, Month]>) {
  const ms = months ?? await allMonths(c);
  return (await loadGoals(c)).map(g => ({ ...g, progress: goalProgress(g, ms) }));
}

class Bad extends Error {}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round((parseFloat(String(v).replace(/[$,\s]/g, '')) || 0) * 100) / 100;
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new Bad('That amount doesn’t look right.');
  return n;
};
const month = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (!isMonthKey(v)) throw new Bad(`${what} looks like 2027-03.`);
  return v;
};

export function registerGoals(app: FastifyInstance, db: Db) {
  app.get('/api/goals', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { goals: await goalsWithProgress(db) };
  });

  app.post('/api/goals', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const kind = b.kind as GoalKind;
      if (!(kind in GOAL_KINDS)) throw new Bad('Pick a kind of goal.');
      const def = GOAL_KINDS[kind];
      const ref = str(b.ref, 120) || null;
      if (def.needsRef && !ref) throw new Bad(def.needsRef === 'loan' ? 'Pick the loan.' : 'Pick the account.');
      const start = month(b.startMonth, 'The start month') ?? (await listMonths(db)).slice(-1)[0];
      if (!start) throw new Bad('Make a month first.');
      const title = str(b.title, 200) || (ref ? `${def.label}: ${ref}` : def.label);
      const target = b.target === undefined ? def.defaultTarget : money(b.target);
      if (kind === 'savings' && target === null) throw new Bad('Set the balance to reach.');
      const r = await db.query(`INSERT INTO goals (kind, title, target, ref, due_month, start_month, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [kind, title, target, ref, month(b.dueMonth, 'The by month'), start, str(b.notes, 2000), user.id]);
      return reply.code(201).send({ goal: row(r.rows[0]), goals: await goalsWithProgress(db) });
    } catch (e) {
      if (e instanceof Bad) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch('/api/goals/:id', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cur = (await db.query('SELECT * FROM goals WHERE id = $1', [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'No such goal.' });
    try {
      const g = row(cur);
      if (b.title !== undefined) g.title = str(b.title, 200) || g.title;
      if (b.target !== undefined) g.target = money(b.target);
      if (b.dueMonth !== undefined) g.dueMonth = month(b.dueMonth, 'The by month');
      if (b.notes !== undefined) g.notes = str(b.notes, 2000);
      if (b.status !== undefined) {
        if (!['active', 'done', 'dropped'].includes(b.status as string)) throw new Bad('Status is active, done or dropped.');
        g.status = b.status as Goal['status'];
        // Ending a goal closes it in the month given (the one on screen), so it stops carrying over after that.
        g.endMonth = g.status === 'active' ? null : (month(b.month, 'The month') ?? (await listMonths(db)).slice(-1)[0] ?? g.startMonth);
        if (g.endMonth && g.endMonth < g.startMonth) g.endMonth = g.startMonth;
      }
      await db.query(`UPDATE goals SET title=$2, target=$3, due_month=$4, notes=$5, status=$6, end_month=$7, updated_at=now() WHERE id=$1`,
        [id, g.title, g.target, g.dueMonth, g.notes, g.status, g.endMonth]);
      return { goals: await goalsWithProgress(db) };
    } catch (e) {
      if (e instanceof Bad) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.delete('/api/goals/:id', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    await db.query('DELETE FROM goals WHERE id = $1', [Number((req.params as { id: string }).id)]);
    return { goals: await goalsWithProgress(db) };
  });
}
