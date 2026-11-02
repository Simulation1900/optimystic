// Web push: over-budget alerts and card sync problems, delivered to phones that turned notifications on.
import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { requireUser } from './auth.js';

export interface PushMessage { title: string; body: string; tag?: string; url?: string }
interface Sub { endpoint: string; keys: { p256dh: string; auth: string } }
type Transport = (sub: Sub, payload: string, opts: webpush.RequestOptions) => Promise<unknown>;

let transport: Transport = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
/** Tests replace the network call. */
export const setPushTransport = (t: Transport) => { transport = t; };

/** The VAPID key pair, made once and kept in the database. */
export async function vapidKeys(db: Db): Promise<{ publicKey: string; privateKey: string }> {
  const r = await db.query("SELECT value FROM app_settings WHERE key = 'vapid'");
  if (r.rowCount) return JSON.parse(r.rows[0].value);
  const k = webpush.generateVAPIDKeys();
  await db.query("INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(k)]);
  return JSON.parse((await db.query("SELECT value FROM app_settings WHERE key = 'vapid'")).rows[0].value);
}

/** Send to every subscribed device (or only some users'). Dead subscriptions are removed. Returns how many got it. */
export async function sendPush(db: Db, cfg: Config, msg: PushMessage, only?: { userIds?: number[]; ownersOnly?: boolean }): Promise<number> {
  const where = only?.ownersOnly ? "WHERE u.role = 'owner'" : only?.userIds ? 'WHERE s.user_id = ANY($1)' : '';
  const subs = (await db.query(`SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id ${where}`,
    only?.userIds && !only.ownersOnly ? [only.userIds] : [])).rows;
  if (!subs.length) return 0;
  const keys = await vapidKeys(db);
  const opts: webpush.RequestOptions = {
    TTL: 12 * 3600,
    urgency: 'normal',
    vapidDetails: { subject: cfg.publicUrl.startsWith('https://') ? cfg.publicUrl : 'mailto:bill-planner@localhost.localdomain', publicKey: keys.publicKey, privateKey: keys.privateKey }
  };
  const payload = JSON.stringify(msg);
  let ok = 0;
  await Promise.all(subs.map(async s => {
    try {
      await transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
      ok++;
      await db.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [s.id]);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); // phone unsubscribed or app removed
    }
  }));
  return ok;
}

const validSub = (s: unknown): s is Sub => {
  const x = s as Sub;
  if (!x || typeof x.endpoint !== 'string' || !x.keys || typeof x.keys.p256dh !== 'string' || typeof x.keys.auth !== 'string') return false;
  try { return new URL(x.endpoint).protocol === 'https:' && x.endpoint.length < 2000 && x.keys.p256dh.length < 200 && x.keys.auth.length < 100; } catch { return false; }
};

export function registerPush(app: FastifyInstance, db: Db, cfg: Config) {
  app.get('/api/push/key', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { publicKey: (await vapidKeys(db)).publicKey };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const sub = (req.body as { subscription?: unknown })?.subscription;
    if (!validSub(sub)) return reply.code(400).send({ error: 'That isn’t a push subscription.' });
    await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.headers['user-agent'] || '').slice(0, 300)]);
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const endpoint = String((req.body as { endpoint?: string })?.endpoint || '');
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, user.id]);
    return { ok: true };
  });

  // Sends a test to the signed-in person's devices.
  app.post('/api/push/test', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const n = await sendPush(db, cfg, { title: 'Bill Planner', body: 'Notifications are working on this device.', tag: 'test', url: '/' }, { userIds: [user.id] });
    if (!n) return reply.code(404).send({ error: 'No device of yours has notifications turned on yet.' });
    return { sent: n };
  });
}
