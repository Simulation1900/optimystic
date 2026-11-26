import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { merchantKey } from '../src/advice.js';
import { fixture, owner, start, stop, type Client, type Ctx } from './setup.js';

describe('budget advice through files', () => {
  let ctx: Ctx, c: Client;
  beforeAll(async () => {
    ctx = await start(); c = await owner(ctx);
    expect((await c.post('/api/import', JSON.parse(fixture('sample-backup.json')))).statusCode).toBe(200);
  });
  afterAll(async () => { await stop(ctx); });

  it('groups a store’s charges under one merchant name', () => {
    expect(merchantKey('KROGER #1234 NASHVILLE TN')).toBe(merchantKey('KROGER #0987 NASHVILLE TN'));
    expect(merchantKey('SQ *BLUE BOTTLE 5551234')).toContain('BLUE BOTTLE');
  });

  it('downloads a brief with months, card categories and the question', async () => {
    const r = await c.get('/api/advice/brief?months=3&question=' + encodeURIComponent('Can we pay the car off early?'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('billplanner-brief-');
    const b = r.json();
    expect(b.format).toBe('billplanner-brief/1');
    expect(b.question).toBe('Can we pay the car off early?');
    expect(b.months.length).toBeGreaterThan(0);
    const m = b.months[b.months.length - 1];
    expect(m.totals).toHaveProperty('left_over_after_bills');
    expect(Array.isArray(m.card_budget.categories)).toBe(true);
    expect(b.instructions).toContain('billplanner-advice/1');
  });

  it('imports advice, keeps the good parts, reports the bad, and shows it newest first', async () => {
    const brief = (await c.get('/api/advice/brief')).json();
    const latest = brief.months[brief.months.length - 1];
    const cat = latest.card_budget.categories[0];
    const advice = {
      format: 'billplanner-advice/1', brief_generated_at: brief.generated_at, question: 'Where is the money going?',
      summary: ['You are $120 short in Checking before the 15th.'],
      recommendations: [
        { title: 'Move the water bill to Savings', detail: 'Savings has room.', area: 'cashflow', priority: 'high', monthly_impact: 0 },
        { title: 'Cancel the second streaming plan', detail: 'Two charges a month.', area: 'card_budget', priority: 'medium', monthly_impact: 15.99 },
        { detail: 'no title' }
      ],
      category_limits: [...(cat ? [{ category_id: cat.category_id, suggested_limit: 432.6, reason: 'Average of 3 months.' }] : []),
        { category_id: 'nope', suggested_limit: 10, reason: 'x' }],
      watch: ['Insurance renews in March.'],
      answer: 'Mostly groceries and dining.'
    };
    const r = (await c.post('/api/advice/import', advice)).json();
    expect(r.recommendations).toBe(2);
    expect(r.errors.length).toBe(2);
    const got = (await c.get('/api/advice')).json().advice;
    expect(got.summary[0]).toContain('$120 short');
    expect(got.question).toBe('Where is the money going?');
    if (cat) expect(got.category_limits[0]).toMatchObject({ category_id: cat.category_id, suggested_limit: 433 });
    // the next brief carries this advice forward for continuity
    expect((await c.get('/api/advice/brief')).json().previous_advice.recommendations).toContain('Move the water bill to Savings');
    expect((await c.post('/api/advice/import', { format: 'something-else' })).statusCode).toBe(400);
    expect((await c.post('/api/advice/import', { format: 'billplanner-advice/1' })).statusCode).toBe(400);
  });

  it('goals carry over, are measured from the months, go in the brief, and get reviewed', async () => {
    const latest = (await c.get('/api/months')).json().months.slice(-1)[0];
    expect((await c.post('/api/goals', { kind: 'loan_payoff' })).statusCode).toBe(400);  // needs the loan
    const r = await c.post('/api/goals', { kind: 'heloc_balance', target: 0, dueMonth: '2027-12' });
    expect(r.statusCode).toBe(201);
    const g = r.json().goal;
    expect(g).toMatchObject({ kind: 'heloc_balance', startMonth: latest, status: 'active', title: 'Pay down the HELOC' });
    const listed = (await c.get('/api/goals')).json().goals[0];
    expect(listed.progress.series.length).toBeGreaterThan(0);
    const brief = (await c.get('/api/advice/brief')).json();
    expect(brief.goals[0]).toMatchObject({ goal_id: g.id, kind: 'heloc_balance', lower_is_better: true });
    expect(brief.month_over_month.length).toBeGreaterThan(0);
    expect(brief.month_over_month[0]).toHaveProperty('cash_on_hand');
    const imp = (await c.post('/api/advice/import', {
      format: 'billplanner-advice/1', month_over_month: ['Better than last month.'], overall_progress: ['Steady.'],
      goal_reviews: [{ goal_id: g.id, status: 'behind', comment: 'Down $0.', next_step: 'Pay $200 extra.' }, { goal_id: 9999, status: 'ok' }],
      suggested_goals: [{ kind: 'heloc_draws', title: 'No draws', target: 0, reason: 'x' }, { kind: 'bogus' }]
    })).json();
    expect(imp.goalReviews).toBe(1);
    expect(imp.errors.length).toBe(2);
    const adv = (await c.get('/api/advice')).json().advice;
    expect(adv.goal_reviews[0]).toMatchObject({ goal_id: g.id, status: 'behind', title: 'Pay down the HELOC' });
    expect(adv.suggested_goals[0].kind).toBe('heloc_draws');
    const done = (await c.patch(`/api/goals/${g.id}`, { status: 'done', month: latest })).json().goals.find((x: { id: number }) => x.id === g.id);
    expect(done).toMatchObject({ status: 'done', endMonth: latest });
  });

  it('agent keys reach only the advice routes, skip the browser origin check, and stop when revoked', async () => {
    const made = (await c.post('/api/agent-keys', { name: 'Claude Code' })).json();
    expect(made.key).toMatch(/^bp_agent_/);
    const as = (method: string, url: string, body?: unknown, key = made.key) => ctx.app.inject({ method: method as 'GET', url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    expect((await as('GET', '/api/agent')).statusCode).toBe(200);
    expect((await as('GET', '/api/advice/brief')).statusCode).toBe(200);
    const posted = await as('POST', '/api/advice/import', { format: 'billplanner-advice/1', summary: ['From the agent.'] });  // no Origin header
    expect(posted.statusCode).toBe(200);
    expect((await as('GET', '/api/months')).statusCode).toBe(403);
    expect((await as('GET', '/api/agent-keys')).statusCode).toBe(403);
    expect((await as('GET', '/api/agent', undefined, 'bp_agent_nope')).statusCode).toBe(401);
    const list = (await c.get('/api/agent-keys')).json().keys;
    expect(list[0].lastUsedAt).not.toBeNull();
    await c.del(`/api/agent-keys/${made.id}`);
    expect((await as('GET', '/api/agent')).statusCode).toBe(401);
  });
});
