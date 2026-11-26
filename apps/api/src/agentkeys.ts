// Agent keys: let an agent session (for example Claude Code on the household's Claude plan) fetch the advice brief and
// send advice back directly, instead of downloading and uploading files. A key works only on the routes in AGENT_ROUTES,
// acts as the owner who made it, is stored as a SHA-256 hash, and can be revoked in Settings.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { requireUser, type User } from './auth.js';

export const KEY_PREFIX = 'bp_agent_';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** What a key may do: read the brief, goals and advice, and send advice back. Nothing that edits the planner itself. */
export const AGENT_ROUTES: Array<[string, string]> = [
  ['GET', '/api/agent'], ['GET', '/api/advice/brief'], ['POST', '/api/advice/import'], ['GET', '/api/advice'], ['GET', '/api/goals']
];

export function isAgentRequest(authorization: string | undefined): boolean {
  return !!authorization && authorization.startsWith(`Bearer ${KEY_PREFIX}`);
}

/** A new key for `userId`; the plain key is returned once and only its hash is kept. */
export async function createAgentKey(db: Db, userId: number, name: string): Promise<{ id: number; key: string }> {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  const r = await db.query('INSERT INTO agent_keys (name, key_hash, created_by) VALUES ($1, $2, $3) RETURNING id', [name.slice(0, 80) || 'Agent', sha(key), userId]);
  return { id: r.rows[0].id, key };
}

export function registerAgentKeys(app: FastifyInstance, db: Db) {
  // Runs after the session hook: a Bearer agent key signs the request in as its owner, on the agent routes only.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAgentRequest(req.headers.authorization)) return;
    const path = req.url.split('?')[0];
    if (!AGENT_ROUTES.some(([m, p]) => m === req.method && p === path)) {
      return reply.code(403).send({ error: 'Agent keys only work on the advice and goals routes. See GET /api/agent.' });
    }
    const key = req.headers.authorization!.slice('Bearer '.length).trim();
    const r = await db.query(`UPDATE agent_keys k SET last_used_at = now() FROM users u
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.id = k.created_by RETURNING u.id, u.name, u.email, u.role, k.name AS key_name`, [sha(key)]);
    if (!r.rowCount) return reply.code(401).send({ error: 'That agent key isn’t valid or was revoked.' });
    const u = r.rows[0];
    req.user = { id: u.id, name: `${u.name} (agent: ${u.key_name})`, email: u.email, role: 'member' } as User;
  });

  app.get('/api/agent', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return {
      app: 'Bill Planner',
      how: 'Send the key as "Authorization: Bearer <key>". Fetch the brief, follow its instructions, and POST the advice JSON back.',
      routes: {
        brief: 'GET /api/advice/brief?months=6&question=<optional>  (billplanner-brief/1; read its "instructions")',
        import: 'POST /api/advice/import  (body: billplanner-advice/1 JSON)',
        goals: 'GET /api/goals',
        latest_advice: 'GET /api/advice'
      }
    };
  });

  const owner = (req: Parameters<typeof requireUser>[0], reply: Parameters<typeof requireUser>[1]) => {
    const u = requireUser(req, reply); if (!u) return null;
    if (u.role !== 'owner' || isAgentRequest(req.headers.authorization)) { reply.code(403).send({ error: 'Only the owner can manage agent keys.' }); return null; }
    return u;
  };

  app.get('/api/agent-keys', async (req, reply) => {
    if (!owner(req, reply)) return;
    const r = await db.query('SELECT id, name, created_at, last_used_at FROM agent_keys WHERE revoked_at IS NULL ORDER BY id');
    return { keys: r.rows.map(k => ({ id: k.id, name: k.name, createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null })) };
  });

  app.post('/api/agent-keys', async (req, reply) => {
    const u = owner(req, reply); if (!u) return;
    const name = String((req.body as Record<string, unknown>)?.name ?? '').trim() || 'Agent';
    return reply.code(201).send(await createAgentKey(db, u.id, name));
  });

  app.delete('/api/agent-keys/:id', async (req, reply) => {
    if (!owner(req, reply)) return;
    await db.query('UPDATE agent_keys SET revoked_at = now() WHERE id = $1', [Number((req.params as { id: string }).id)]);
    return { ok: true };
  });
}
