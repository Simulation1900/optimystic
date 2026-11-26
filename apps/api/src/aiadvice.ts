// "Refresh advice": the same brief an outside agent gets, sent to Claude through the API, and the reply saved like an
// imported advice file. Every call is costed and counted against a monthly cap (AI_MONTHLY_BUDGET_USD).
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { requireUser } from './auth.js';

/** Dollars per million tokens: input, output. An unknown model is costed at the highest price. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-2': [8, 40]
};

export function costOf(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const [pin, pout] = PRICES[model] ?? Object.values(PRICES).reduce((a, b) => (b[1] > a[1] ? b : a));
  const inp = usage.input_tokens ?? 0, out = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
  return (inp * pin + write * pin * 1.25 + read * pin * 0.1 + out * pout) / 1e6;
}

/** The JSON object in a reply, even if it came wrapped in a code fence or a sentence. */
export function jsonFrom(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Claude’s reply had no JSON in it.');
  return JSON.parse(text.slice(a, b + 1));
}

type Brief = Record<string, unknown> & { instructions: string };
type Client = Pick<Anthropic, 'messages'>;

/** Tests swap in a fake Claude client here. */
let makeClient: ((key: string) => Client) | null = null;
export function setAiClientForTests(f: ((key: string) => Client) | null) { makeClient = f; }
type Saved = { id: number } & Record<string, unknown>;

export function registerAiAdvice(app: FastifyInstance, db: Db, cfg: Config,
  h: { makeBrief: (n: number, q: string) => Promise<Brief | null>; saveAdvice: (uid: number, body: unknown, q: string | null) => Promise<Saved> }) {
  const clientFactory = (): Client => (makeClient ? makeClient(cfg.anthropicApiKey) : new Anthropic({ apiKey: cfg.anthropicApiKey }));
  let running = false;

  async function monthSpend(): Promise<number> {
    const r = await db.query(`SELECT coalesce(sum(cost_usd), 0) AS s FROM ai_usage WHERE at >= date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1`, [cfg.tz]);
    return Number(r.rows[0].s) || 0;
  }
  const state = async () => ({ available: !!cfg.anthropicApiKey, model: cfg.adviceModel, spentUsd: Math.round((await monthSpend()) * 100) / 100,
    capUsd: cfg.aiMonthlyBudgetUsd, running });

  app.get('/api/advice/ai', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return state();
  });

  app.post('/api/advice/refresh', async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    if (!cfg.anthropicApiKey) return reply.code(400).send({ error: 'No Claude API key is set on the server, so refresh is off. Agent files still work.' });
    if (running) return reply.code(409).send({ error: 'Advice is already being written. Give it a minute.' });
    const spent = await monthSpend();
    if (spent >= cfg.aiMonthlyBudgetUsd) return reply.code(429).send({ error: `This month’s AI budget of $${cfg.aiMonthlyBudgetUsd} is used up ($${spent.toFixed(2)} spent).` });
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const question = typeof b.question === 'string' ? b.question.trim().slice(0, 2000) : '';
    const brief = await h.makeBrief(Math.min(24, Math.max(1, Number(b.months) || 6)), question);
    if (!brief) return reply.code(404).send({ error: 'There are no months in the planner yet.' });

    running = true;
    const { instructions, ...data } = brief;
    const system = `${instructions}\n\nYou are being called through the API, not as a file-writing agent: instead of saving a file, reply with ONLY the billplanner-advice/1 JSON object, with no other text and no code fence.`;
    try {
      const stream = clientFactory().messages.stream({
        model: cfg.adviceModel, max_tokens: 32000, system,
        messages: [{ role: 'user', content: `Here is the household's brief (billplanner-brief/1):\n\n${JSON.stringify(data)}` }]
      });
      const msg = await stream.finalMessage();
      const cost = costOf(msg.model || cfg.adviceModel, msg.usage);
      await db.query('INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, 'advice', msg.model || cfg.adviceModel, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0, cost]);
      if (msg.stop_reason === 'refusal') return reply.code(502).send({ error: 'Claude declined to write this advice.' });
      if (msg.stop_reason === 'max_tokens') return reply.code(502).send({ error: 'Claude’s reply was cut off. Try fewer months.' });
      const text = msg.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('');
      let body: unknown;
      try { body = jsonFrom(text); } catch { return reply.code(502).send({ error: 'Claude’s reply wasn’t valid advice JSON. Try again.' }); }
      const saved = await h.saveAdvice(user.id, body, question || null);
      return { ...saved, costUsd: Math.round(cost * 1000) / 1000, model: msg.model };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return reply.code(502).send({ error: 'The Claude API key on the server was refused. Check it in the Console.' });
      if (e instanceof Anthropic.RateLimitError) return reply.code(429).send({ error: 'Claude is busy right now. Try again in a minute.' });
      if (e instanceof Anthropic.APIError) return reply.code(502).send({ error: `Claude returned an error (${e.status ?? 'no status'}). Try again.` });
      if (e instanceof Error && /no summary|format/.test(e.message)) return reply.code(502).send({ error: e.message });
      throw e;
    } finally {
      running = false;
    }
  });
}
