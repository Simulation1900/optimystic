import pg from 'pg';
import { MIGRATIONS } from './migrations.js';

// numeric comes back as a string by default; the planner works in numbers (rounded to the cent by the core).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, v => (v === null ? null : Number(v)));
// date columns stay 'YYYY-MM-DD' strings, never JS Dates (no time zone drift).
pg.types.setTypeParser(pg.types.builtins.DATE, v => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Apply any migrations not yet run. Safe to call on every start; an advisory lock keeps two starts from racing. */
export async function migrate(db: Db): Promise<number[]> {
  return tx(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(4207011)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map(r => r.id as number));
    const ran: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await c.query(m.sql);
      await c.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
      ran.push(m.id);
    }
    return ran;
  });
}
