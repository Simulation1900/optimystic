// "Ask": a chat about the household's money. Claude gets the same data as the advice brief (cached between messages,
// so follow-ups are cheap), answers from it, and can't change anything. Replies stream to the browser as server-sent
// events. Every call is costed against the same monthly cap as Refresh advice.
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { requireUser } from './auth.js';
import { addMonths, applyOp, clone, isMonthKey } from '@optimystic/core';
import { tx } from './db.js';
import { aiClient, monthSpend, recordUsage } from './aiadvice.js';
import { listMonths, loadMonth, lockMonths, saveMonth } from './repo.js';
import { refreshStatementBills } from './planner.js';

const HISTORY = 20;
const PER_HOUR = 40;

const RULES = `You are the household's budgeting assistant inside their self-hosted Bill Planner app. The household data
follows: their accounts, monthly bills, transfers, loans, HELOC, card spending by category (pending charges included and
marked), goals with progress, a month-by-month table, and the latest advice they received.

How to answer:
- Use only the numbers in the data and arithmetic on them. Never invent balances, rates, income or dates. If the data
  doesn't say, say so and suggest where in the app to look or what to enter.
- Be brief and concrete: a short paragraph or a few bullets, exact dollar figures, the names of the bills, categories,
  merchants, loans and accounts involved. Show a quick calculation when it helps.
- When an account ends the month short, the household covers it by drawing on the HELOC, so a shortfall is a HELOC
  draw: it adds to the balance at the HELOC's rate and raises the payment.
- You can change one thing: a card budget category's monthly limit, with the set_category_limit tool, in the month the
  person is viewing (named at the start of their message). Use it only when they ask you to change a budget amount, or
  clearly say yes to a change you suggested; never on your own initiative. Use the category_id from that month's
  card_budget.categories. After changing it, say what changed (old and new limit). Anything else (bills, accounts,
  transfers, loans, goals, settings) you can't change: say exactly where in the app to do it.
- Don't recommend specific investment products; for tax or legal questions, suggest a professional.
- Plain text with simple "- " bullets; no headings, tables or code blocks.`;

const TOOLS: Anthropic.Tool[] = [{
  name: 'set_category_limit',
  description: 'Change the monthly spending limit of one card budget category in the month the person is viewing. Only call this when the person asked to change a budget amount or agreed to a change you proposed.',
  input_schema: {
    type: 'object',
    properties: {
      category_id: { type: 'string', description: 'The category_id from card_budget.categories for the month being viewed.' },
      new_limit: { type: 'number', description: 'The new monthly limit in dollars (0 or more).' }
    },
    required: ['category_id', 'new_limit']
  },
  eager_input_streaming: true
} as Anthropic.Tool];

export type LimitChange = { month: string; categoryId: string; name: string; from: number; to: number };

/** Apply one limit change the way the app's own edits are applied: locked, versioned, audited, statements refreshed. */
async function setCategoryLimit(db: Db, userId: number, key: string, input: unknown): Promise<LimitChange> {
  const x = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = typeof x.category_id === 'string' ? x.category_id : '';
  const limit = Number(x.new_limit);
  if (!id || !Number.isFinite(limit) || limit < 0 || limit > 100000) throw new Error('category_id and a new_limit from 0 to 100000 are required.');
  return tx(db, async c => {
    await lockMonths(c, [key]);
    const before = await loadMonth(c, key);
    if (!before) throw new Error(`There's no ${key} in the planner.`);
    const cat = before.budget.cats.find(k => k.id === id);
    if (!cat) throw new Error(`No category ${id} in ${key}.`);
    const after = clone(before);
    applyOp(after, key, { type: 'cat.update', id, patch: { limit: Math.round(limit * 100) / 100 } });
    await saveMonth(c, key, before, after, userId, 'chat');
    await refreshStatementBills(c, [key, addMonths(key, 1)], userId);
    return { month: key, categoryId: id, name: cat.name, from: Number(cat.limit) || 0, to: Number(after.budget.cats.find(k => k.id === id)!.limit) || 0 };
  });
}

export function registerChat(app: FastifyInstance, db: Db, cfg: Config, h: { makeBrief: (n: number, q: string) => Promise<(Record<string, unknown> & { instructions: string }) | null> }) {
  const hits = new Map<number, number[]>();
  const allow = (uid: number) => {
    const now = Date.now(), list = (hits.get(uid) || []).filter(t => now - t < 3600_000);
    if (list.length >= PER_HOUR) return false;
    list.push(now); hits.set(uid, list); return true;
  };

  app.get('/api/chat', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const r = await db.query('SELECT role, content, created_at FROM chat_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 60', [user.id]);
    return { available: !!cfg.anthropicApiKey, messages: r.rows.reverse().map(m => ({ role: m.role, content: m.content, at: new Date(m.created_at).toISOString() })) };
  });

  app.delete('/api/chat', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    await db.query('DELETE FROM chat_messages WHERE user_id = $1', [user.id]);
    return { ok: true };
  });

  app.post('/api/chat', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = String(body.message ?? '').trim().slice(0, 4000);
    const months = await listMonths(db);
    const viewing = isMonthKey(body.month) && months.includes(body.month as string) ? body.month as string : months[months.length - 1];
    if (!message) return reply.code(400).send({ error: 'Type a question first.' });
    if (!cfg.anthropicApiKey) return reply.code(400).send({ error: 'No Claude API key is set on the server, so chat is off.' });
    const spent = await monthSpend(db, cfg);
    if (spent >= cfg.aiMonthlyBudgetUsd) return reply.code(429).send({ error: `This month’s AI budget of $${cfg.aiMonthlyBudgetUsd} is used up.` });
    if (!allow(user.id)) return reply.code(429).send({ error: `That’s ${PER_HOUR} questions this hour. Try again a bit later.` });
    const brief = await h.makeBrief(6, '');
    if (!brief) return reply.code(404).send({ error: 'There are no months in the planner yet.' });

    // Leave out what changes on every call (the brief's timestamp) so the data block stays cached between messages.
    const { instructions: _i, return_format: _r, generated_at: _g, question: _q, ...data } = brief;
    const history = (await db.query('SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [user.id, HISTORY])).rows.reverse();
    while (history.length && history[0].role !== 'user') history.shift();
    await db.query('INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [user.id, 'user', message]);

    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    const send = (e: Record<string, unknown>) => { if (!out.writableEnded) out.write(`data: ${JSON.stringify(e)}\n\n`); };
    let text = '', cost = 0;
    const changes: LimitChange[] = [];
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: RULES },
      { type: 'text', text: `Household data (JSON):\n${JSON.stringify(data)}`, cache_control: { type: 'ephemeral' } }];
    const convo: Anthropic.MessageParam[] = [...history.map(m => ({ role: m.role as 'user' | 'assistant', content: String(m.content) })),
      { role: 'user', content: `(Viewing ${viewing}.) ${message}` }];
    try {
      for (let turn = 0; turn < 4; turn++) {
        const stream = aiClient(cfg).messages.stream({ model: cfg.chatModel, max_tokens: 4000, system, tools: TOOLS, messages: convo });
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') { text += ev.delta.text; send({ type: 'text', text: ev.delta.text }); }
        }
        const msg = await stream.finalMessage();
        cost += await recordUsage(db, user.id, 'chat', msg.model || cfg.chatModel, msg.usage);
        if (msg.stop_reason === 'refusal') { send({ type: 'error', message: 'Claude declined to answer that.' }); return; }
        if (msg.stop_reason !== 'tool_use') break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of msg.content) {
          if (b.type !== 'tool_use') continue;
          try {
            if (b.name !== 'set_category_limit') throw new Error(`Unknown tool ${b.name}.`);
            const ch = await setCategoryLimit(db, user.id, viewing, b.input);
            changes.push(ch);
            send({ type: 'change', ...ch });
            results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ ok: true, ...ch }) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: (err as Error).message });
          }
        }
        convo.push({ role: 'assistant', content: msg.content }, { role: 'user', content: results });
        if (text && !text.endsWith('\n')) { text += '\n\n'; send({ type: 'text', text: '\n\n' }); }
      }
      if (!text.trim() && !changes.length) { send({ type: 'error', message: 'Claude didn’t send an answer. Try asking again.' }); return; }
      const saved = text.trim() || changes.map(ch => `Changed ${ch.name} from $${ch.from} to $${ch.to}.`).join('\n');
      await db.query('INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [user.id, 'assistant', saved]);
      send({ type: 'done', costUsd: Math.round(cost * 10000) / 10000 });
    } catch (e) {
      const m = e instanceof Anthropic.AuthenticationError ? 'The Claude API key on the server was refused.'
        : e instanceof Anthropic.RateLimitError ? 'Claude is busy right now. Try again in a minute.'
          : e instanceof Anthropic.APIError ? `Claude returned an error (${e.status ?? 'no status'}). Try again.` : 'Something went wrong while answering. Try again.';
      if (text.trim()) await db.query('INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [user.id, 'assistant', text]).catch(() => undefined);
      send({ type: 'error', message: m });
    } finally {
      out.end();
    }
  });
}
