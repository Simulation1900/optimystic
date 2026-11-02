// Card sync: pull the two credit cards' charges from SimpleFIN into the card budget.
import type { FastifyInstance } from 'fastify';
import { addMonths, cardItems, clone, fmt, importSynced, newlyOverBudget, syncMessage, todayISO, withPending, type Month, type OverBudget, type SyncResult } from '@optimystic/core';
import { tx, type Db } from './db.js';
import type { Config } from './config.js';
import { requireUser } from './auth.js';
import { categoryMemory, listMonths, loadMonth, lockMonths, pendingCharges, saveMonth } from './repo.js';
import { claim, decrypt, encrypt, fetchAccounts, SyncError } from './simplefin.js';
import { sendPush } from './push.js';
import { refreshStatementBills } from './planner.js';

const LOOKBACK_DAYS = 10; // late-posting charges are caught on the next runs

export interface SyncStatus {
  connected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastResult: (SyncResult & { message: string; pending: number }) | null;
  accounts: Array<{ id: string; name: string; org: string; balance: number | null; balanceDate: string | null; cardKey: string | null }>;
  schedule: string[];
  canConnect: boolean;
}

export async function syncStatus(db: Db | { query: Db['query'] }, cfg: Config): Promise<SyncStatus> {
  const c = (await db.query('SELECT id, last_sync_at, last_error, last_result FROM bank_connections ORDER BY id DESC LIMIT 1')).rows[0];
  const links = c ? (await db.query('SELECT * FROM bank_links WHERE connection_id = $1 ORDER BY org, name', [c.id])).rows : [];
  return {
    connected: !!c,
    lastSyncAt: c?.last_sync_at ? new Date(c.last_sync_at).toISOString() : null,
    lastError: c?.last_error ?? null,
    lastResult: c?.last_result ?? null,
    accounts: links.map(l => ({ id: l.sf_account_id, name: l.name, org: l.org, balance: l.balance === null ? null : Number(l.balance),
      balanceDate: l.balance_date ? new Date(l.balance_date).toISOString() : null, cardKey: l.card_key })),
    schedule: cfg.syncTimes,
    canConnect: !!cfg.syncKey
  };
}

let running: Promise<SyncStatus> | null = null;

/** One sync run. Runs never overlap; a second request waits for the one in progress. */
export function runSync(db: Db, cfg: Config, userId: number | null, since?: number): Promise<SyncStatus> {
  if (!running) running = doSync(db, cfg, userId, since).finally(() => { running = null; });
  return running;
}

/** How far back a one-time backfill may reach (SimpleFIN keeps about 90 days). */
export const MAX_BACKFILL_DAYS = 90;

async function doSync(db: Db, cfg: Config, userId: number | null, sinceOverride?: number): Promise<SyncStatus> {
  const conn = (await db.query('SELECT * FROM bank_connections ORDER BY id DESC LIMIT 1')).rows[0];
  if (!conn) throw new SyncError('Card sync isn’t connected.', 404);
  try {
    const access = decrypt(conn.access_url_enc, cfg.syncKey);
    const since = sinceOverride ?? Date.now() / 1000 - LOOKBACK_DAYS * 86400;
    const data = await fetchAccounts(access, since, cfg.simplefinAllowHttp);

    // Remember every account SimpleFIN offers (new ones start unlinked) and its latest balance.
    for (const a of data.accounts) {
      await db.query(`INSERT INTO bank_links (connection_id, sf_account_id, name, org, balance, balance_date) VALUES ($1,$2,$3,$4,$5,to_timestamp($6))
        ON CONFLICT (connection_id, sf_account_id) DO UPDATE SET name = EXCLUDED.name, org = EXCLUDED.org, balance = EXCLUDED.balance, balance_date = EXCLUDED.balance_date`,
        [conn.id, String(a.id), String(a.name || ''), String(a.org?.name || a.org?.domain || ''), a.balance === undefined ? null : Number(a.balance) || 0, a['balance-date'] || null]);
    }
    const links = (await db.query('SELECT sf_account_id, card_key FROM bank_links WHERE connection_id = $1 AND card_key IS NOT NULL', [conn.id])).rows;

    const total: SyncResult & { pending: number } = { added: 0, matched: 0, already: 0, skipped: 0, older: 0, months: [], pending: 0 };
    let over: OverBudget[] = [];
    await tx(db, async c => {
      const all = await listMonths(c);
      const current = todayISO(cfg.tz).slice(0, 7);
      const template = all.includes(current) ? current : all[all.length - 1];
      // The working month as it reads now, pending charges included, to see which categories this sync pushes over.
      const shownBefore = async () => { const m = await loadMonth(c, template); return m ? withPending(m, await pendingCharges(c, template, m), template) : null; };
      const pre = template ? await shownBefore() : null;
      for (const l of links) {
        const acct = data.accounts.find(a => String(a.id) === l.sf_account_id);
        if (!acct) continue;
        const { items, pending, pendingItems } = cardItems(acct.transactions || [], cfg.tz);
        total.pending += pending;
        await c.query('DELETE FROM card_pending WHERE connection_id = $1 AND card_key = $2', [conn.id, l.card_key]);
        for (const p of pendingItems) {
          await c.query('INSERT INTO card_pending (connection_id, id, card_key, date, description, amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [conn.id, p.id, l.card_key, p.date, p.desc.slice(0, 200), p.amount]);
        }
        if (!items.length) continue;
        // The months the charges fall in, plus their neighbours (a CSV line can sit a few days away).
        const keys = new Set<string>();
        items.forEach(i => { const k = i.date.slice(0, 7); [addMonths(k, -1), k, addMonths(k, 1)].forEach(x => { if (all.includes(x)) keys.add(x); }); });
        if (template) keys.add(template);
        await lockMonths(c, [...keys]);
        const before: Record<string, Month> = {};
        for (const k of keys) before[k] = (await loadMonth(c, k))!;
        const after = clone(before);
        const r = importSynced(after, items, l.card_key, template ? after[template] : undefined, undefined, await categoryMemory(c), all[0]);
        for (const k of keys) await saveMonth(c, k, before[k], after[k], userId, 'card-sync');
        total.added += r.added; total.matched += r.matched; total.already += r.already; total.skipped += r.skipped; total.older = (total.older || 0) + (r.older || 0);
        total.months = [...new Set([...total.months, ...r.months])].sort();
      }
      // New charges change the statements the card bills come from (this month's and next month's).
      // Pending charges change projected statements too, so refresh the working month's bills on every sync.
      await refreshStatementBills(c, [...total.months.flatMap(k => [k, addMonths(k, 1)]), ...(template ? [template] : [])], userId);
      // Over-budget alerts only for the working month (this month, or the latest one), pending charges counted:
      // a category alerts when posted + pending first crosses its limit, not again when a pending charge posts.
      const post = template ? await shownBefore() : null;
      if (pre && post) over = newlyOverBudget(pre, post);
    });
    const result = { ...total, message: syncMessage(total) + (total.pending ? ` ${total.pending} pending charge${total.pending === 1 ? '' : 's'} will come in once posted.` : '') };
    // SimpleFIN reports bank problems (like a login that needs fixing) in `errors` while still returning what it can.
    const err = data.errors.length ? `SimpleFIN: ${data.errors.join(' ')}` : (!links.length ? 'No card is linked yet. Choose which SimpleFIN account is which card.' : null);
    await db.query('UPDATE bank_connections SET last_sync_at = now(), last_error = $2, last_result = $3 WHERE id = $1', [conn.id, err, JSON.stringify(result)]);
    await alertOverBudget(db, cfg, over);
    if (err && err !== conn.last_error && data.errors.length) await alertSyncProblem(db, cfg, err);
  } catch (e) {
    const msg = e instanceof SyncError ? e.message : 'Card sync failed on the server.';
    await db.query('UPDATE bank_connections SET last_error = $2 WHERE id = $1', [conn.id, msg]);
    if (msg !== conn.last_error) await alertSyncProblem(db, cfg, msg);
    if (!(e instanceof SyncError)) throw e;
  }
  return syncStatus(db, cfg);
}

/** One notification per category that a synced charge just put over its limit. Push failures never fail a sync. */
async function alertOverBudget(db: Db, cfg: Config, over: OverBudget[]) {
  for (const o of over) {
    await sendPush(db, cfg, {
      title: `${o.name} is over budget`,
      body: `${fmt(o.spent)} of ${fmt(o.limit)} this month${o.cardName ? ` (${o.cardName})` : ''}.`,
      tag: `over-${o.catId}`, url: '/?tab=budget'
    }).catch(() => 0);
  }
}

/** Tell the owner once when card sync starts having a problem (not again until the message changes). */
async function alertSyncProblem(db: Db, cfg: Config, msg: string) {
  await sendPush(db, cfg, { title: 'Card sync needs attention', body: msg, tag: 'sync-problem', url: '/?tab=settings' }, { ownersOnly: true }).catch(() => 0);
}

export function registerSync(app: FastifyInstance, db: Db, cfg: Config) {
  const fail = (reply: import('fastify').FastifyReply, e: unknown) => {
    if (e instanceof SyncError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  app.get('/api/sync', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return syncStatus(db, cfg);
  });

  // Owner only: paste a SimpleFIN setup token.
  app.post('/api/sync/connect', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can connect card sync.' });
    const token = String((req.body as { token?: string })?.token || '');
    try {
      if (!cfg.syncKey) throw new SyncError('Set SYNC_KEY in the server’s .env (openssl rand -hex 32), restart, then connect again.', 503);
      if (!token.trim()) throw new SyncError('Paste the setup token from SimpleFIN Bridge.');
      const access = await claim(token, cfg.simplefinAllowHttp);
      const enc = encrypt(access, cfg.syncKey);
      await tx(db, async c => {
        await c.query('DELETE FROM bank_connections');
        await c.query('INSERT INTO bank_connections (access_url_enc, created_by) VALUES ($1, $2)', [enc, user.id]);
      });
      return await runSync(db, cfg, user.id); // lists the accounts so they can be linked
    } catch (e) { return fail(reply, e); }
  });

  // Owner only: which SimpleFIN account is which card ({ links: { [sfAccountId]: cardKey | null } }).
  app.post('/api/sync/links', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can link cards.' });
    const links = ((req.body as { links?: Record<string, string | null> })?.links) || {};
    const conn = (await db.query('SELECT id FROM bank_connections ORDER BY id DESC LIMIT 1')).rows[0];
    if (!conn) return reply.code(404).send({ error: 'Card sync isn’t connected.' });
    const cards = new Set<string>();
    for (const k of await listMonths(db)) (await loadMonth(db, k))!.budget.cards.forEach(c => cards.add(c.id));
    for (const [sf, card] of Object.entries(links)) {
      if (card && !cards.has(card)) return reply.code(400).send({ error: 'That card isn’t in the planner.' });
      const old = (await db.query('SELECT card_key FROM bank_links WHERE connection_id = $1 AND sf_account_id = $2', [conn.id, sf])).rows[0]?.card_key;
      await db.query('UPDATE bank_links SET card_key = $3 WHERE connection_id = $1 AND sf_account_id = $2', [conn.id, sf, card || null]);
      if (old && old !== card) await db.query('DELETE FROM card_pending WHERE connection_id = $1 AND card_key = $2', [conn.id, old]);
    }
    return syncStatus(db, cfg);
  });

  // Sync now. With { since: 'YYYY-MM-DD' } it also brings in older charges (a one-time backfill, up to 90 days).
  app.post('/api/sync/run', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const sinceIso = String((req.body as { since?: string } | undefined)?.since || '');
    let since: number | undefined;
    if (sinceIso) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceIso)) return reply.code(400).send({ error: 'Pick a date.' });
      since = Date.parse(sinceIso + 'T00:00:00Z') / 1000 - 86400; // a day's margin for time zones
      const floor = Date.now() / 1000 - MAX_BACKFILL_DAYS * 86400;
      if (since < floor) return reply.code(400).send({ error: `SimpleFIN only keeps about ${MAX_BACKFILL_DAYS} days. Use a CSV download for anything older.` });
    }
    try { return await runSync(db, cfg, user.id, since); } catch (e) { return fail(reply, e); }
  });

  // Owner only: forget the access URL (also revoke it in the SimpleFIN Bridge dashboard).
  app.delete('/api/sync', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Only the owner can disconnect card sync.' });
    await db.query('DELETE FROM bank_connections');
    return syncStatus(db, cfg);
  });
}

/** Sync at the configured local times (6 AM and 6 PM by default). Checks once a minute. */
export function startSyncSchedule(db: Db, cfg: Config, log: (msg: string, err?: unknown) => void): () => void {
  let lastSlot = '';
  const tick = async () => {
    const now = new Date();
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const slot = `${todayISO(cfg.tz, now)} ${hm}`;
    if (!cfg.syncTimes.includes(hm) || slot === lastSlot) return;
    lastSlot = slot;
    const has = (await db.query('SELECT 1 FROM bank_connections LIMIT 1')).rowCount;
    if (!has) return;
    try { await runSync(db, cfg, null); log(`card sync ran at ${slot}`); } catch (e) { log('card sync failed', e); }
  };
  const iv = setInterval(() => { tick().catch(e => log('card sync check failed', e)); }, 60_000);
  return () => clearInterval(iv);
}
