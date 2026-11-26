// Budget advice without an AI key: the app writes a brief of the household's money, an outside agent (for example
// Claude Code on a Claude subscription) writes advice back in a fixed shape, and the app shows it. Nothing in the
// advice changes the planner by itself; suggested category limits get an Apply button on the Advice tab.
import type { FastifyInstance } from 'fastify';
import { addMonths, budgetStats, GOAL_KINDS, withPending, helocCalc, isMonthKey, monthLabel, monthMetrics, monthTotals, shortfalls, todayISO, type Goal, type GoalKind, type GoalProgress, type Month } from '@optimystic/core';
import { allMonths, goalsWithProgress, loadGoals } from './goals.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { requireUser } from './auth.js';
import { listMonths, loadMonth, pendingCharges } from './repo.js';

export const BRIEF_FORMAT = 'billplanner-brief/1';
export const ADVICE_FORMAT = 'billplanner-advice/1';
const AREAS = ['cashflow', 'bills', 'card_budget', 'debt', 'savings', 'other'] as const;
const GOAL_STATUSES = ['on_track', 'ahead', 'behind', 'at_risk', 'done'] as const;
const PRIORITIES = ['high', 'medium', 'low'] as const;

const INSTRUCTIONS = `You are a careful, practical budgeting advisor for one household. This file is a snapshot of their
self-hosted Bill Planner: accounts, monthly bills, transfers, loans, a HELOC, and card spending by budget category with the
individual charges. Read all of it, then write ONE JSON file in the billplanner-advice/1 format shown in return_format and
save it next to this file as billplanner-advice-<YYYYMMDD>.json. Copy this file's generated_at into brief_generated_at and
its question (or null) into question.

What to write:
1. summary: 2-4 short paragraphs. Where the household stands this month (left over after bills, shortfalls, card spending
   against limits). Plain language, second person ("you"), no jargon.
1a. month_over_month: 1-3 paragraphs comparing the latest month with the month before it, using month_over_month rows:
   what got better or worse (left over, cash on hand, card spending and overage, HELOC balance and draws, loan balances,
   savings balances) by how much, and the main reason where the data shows one (a category, a bill, a draw).
1b. overall_progress: 1-3 paragraphs on the whole history in month_over_month: the direction since the first month,
   totals paid down or saved, and whether the household is better off than when it started.
1c. goal_reviews: one entry for every goal in goals with status "active" (use goal_id exactly). status is one of
   on_track, ahead, behind, at_risk or done; comment says how it moved this month and overall using its progress series
   and target (and due_month if set: is the pace enough? say the monthly amount needed); next_step is one concrete action.
1d. suggested_goals: up to 3 new goals worth setting if the data shows an obvious one that isn't already a goal (kind from
   allowed_values.goal_kind; ref is a loan or account name exactly as in the data; target in dollars; due_month YYYY-MM or
   null; reason one sentence). Empty if the current goals already cover it.
2. recommendations: 4-10 specific actions, most valuable first. Each names exact bills, categories, merchants, loans or
   accounts from the data, says what to do, and estimates monthly_impact in dollars saved or freed (null if you can't
   estimate it honestly). Good topics: categories that run over their limit month after month and why (which merchants),
   subscriptions and repeat charges worth reviewing, bills due before the deposit that pays them, accounts that run short
   and a better split of bills or transfers between accounts, paying down the highest-rate debt first, HELOC interest,
   building a buffer. Be honest when the numbers are tight. Don't recommend specific investment products, and suggest a
   professional for tax or legal questions.
3. category_limits: for card budget categories whose limit doesn't match real spending, a suggested monthly limit (whole
   dollars) with the reason (e.g. "averaged $412 over 4 months; groceries rarely drop below $380"). Use category_id exactly
   as given. Only include categories you'd change. Keep the total of all limits realistic for their income and bills.
4. watch: up to 6 short things to keep an eye on next month (a bill that's going up, a promo rate ending, a category
   already at 80%).
5. answer: if the brief has a question, answer it directly in 1-3 paragraphs; otherwise null.
6. charts: 2-6 charts wherever a picture says it faster than words: the month-to-month trend you describe (left over,
   card spending against limits, HELOC balance and draws), the categories over their limits, a debt payoff or HELOC
   projection, the effect of a recommendation. Each chart: title, kind ("bar" or "line"), unit ("$" or "%"), labels
   (the x-axis, e.g. months or category names, up to 24), series (1-4, each with a name and one number per label) and a
   one-sentence caption saying what to notice. Only numbers from this file or arithmetic on them. The app already shows
   its own month-by-month charts of left over, card spending, HELOC balance and draws, and cash on hand, so make yours
   add something (a breakdown, a comparison, a projection).

How this household uses the HELOC: when an account ends the month short, the shortfall is covered by drawing on the
HELOC. So treat every shortfall (months[].shortfalls, month_over_month[].shortfall_to_heloc) as a HELOC draw: it adds
to heloc.balance at heloc.rate_percent, raises the monthly payment, and uses up heloc.available. Say what this month's
shortfall will add to the HELOC balance and to its monthly interest (amount x rate / 12), and treat closing shortfalls as
the way to stop the HELOC growing.

Rules: use only the numbers in this file and arithmetic on them; never invent balances, rates or income. Pending card
charges haven't posted yet but will: every spending figure here already includes them (card totals, categories, merchants,
overage, projected card bills), each month shows pending_total and each category its pending part, and recent charges
flag them with pending: true. Count them in your recommendations, limits and projections like any other charge, and
say when a category is over its limit only because of pending charges. A bill marked paid has already left its account. The brief holds private financial data: don't send it
or any part of it anywhere else. Make sure the file is valid JSON with no comments.`;

/** A store name without the noise banks add (card numbers, city, store numbers), so repeat merchants group together. */
export function merchantKey(desc: string): string {
  return desc.toUpperCase().replace(/^\s*(SQ|TST|SP|PAYPAL|PP)\s*\*\s*/, '').replace(/#\S*/g, ' ').replace(/\*/g, ' ').replace(/\d{3,}/g, ' ')
    .replace(/[^A-Z&' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ') || desc.trim();
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function monthSummary(key: string, m: Month) {
  const t = monthTotals(m), b = budgetStats(m), short = shortfalls(m);
  const acct = (id: string | null) => m.accounts.find(a => a.id === id)?.name ?? (id ? 'unknown account' : 'unassigned');
  const cat = (id: string) => m.budget.cats.find(c => c.id === id);
  const merchants = new Map<string, { total: number; count: number; cats: Set<string> }>();
  for (const e of m.budget.expenses) {
    const k = merchantKey(e.desc), x = merchants.get(k) ?? { total: 0, count: 0, cats: new Set<string>() };
    x.total += Number(e.amount) || 0; x.count++; x.cats.add(cat(e.catId)?.name ?? 'uncategorised');
    merchants.set(k, x);
  }
  const isPending = (id: string) => id.startsWith('pending-');
  const pendingByCat: Record<string, number> = {};
  let pendingTotal = 0;
  for (const e of m.budget.expenses) if (isPending(e.id)) { pendingByCat[e.catId] = (pendingByCat[e.catId] || 0) + (Number(e.amount) || 0); pendingTotal += Number(e.amount) || 0; }
  return {
    key, label: monthLabel(key), card_only: !!m.cardOnly, pending_total: r2(pendingTotal),
    totals: { starting_balances: t.cash, cash_on_hand: t.onHand, deposits_expected: t.deposits, bills: t.bills, bills_marked_paid: t.paid, bills_not_marked_paid: t.due,
      left_over_after_bills: t.left, unassigned_bills: t.unassigned },
    accounts: m.accounts.map(a => ({ name: a.name, starting_balance: Number(a.balance) || 0, cash_on_hand: t.accounts[a.id]?.onHand ?? null,
      deposits_expected: Number(a.deposit) || 0,
      ending_balance: t.accounts[a.id]?.left ?? null })),
    shortfalls: short.map(s => ({ account: s.account.name, need: s.need })),
    projected_heloc_draw: r2(short.reduce((t, s) => t + s.need, 0)),
    bills: m.bills.map(x => ({ name: x.name, amount: Number(x.amount) || 0, due_day: x.dueDay, recurring: x.recurring, paid: x.paid, account: acct(x.accountId) })),
    transfers: (m.transfers || []).map(x => ({ from: acct(x.fromId), to: acct(x.toId), amount: Number(x.amount) || 0, note: x.note, recurring: x.recurring, done: x.done })),
    card_budget: {
      planned_total: b.limit, spent_total: b.spent,
      cards: b.cards.map(c => ({ name: c.name, budget: c.budget, spent: c.spent, projected_bill: c.projected })),
      categories: m.budget.cats.map(c => ({ category_id: c.id, name: c.name, card: m.budget.cards.find(k => k.id === c.cardId)?.name ?? '',
        limit: Number(c.limit) || 0, spent: r2(b.byCat[c.id] || 0), pending: r2(pendingByCat[c.id] || 0) })),
      top_merchants: [...merchants.entries()].sort((a, z) => z[1].total - a[1].total).slice(0, 25)
        .map(([name, x]) => ({ merchant: name, total: r2(x.total), charges: x.count, categories: [...x.cats] }))
    }
  };
}

type GoalWithProgress = Goal & { progress: GoalProgress };

export function buildBrief(months: Array<[string, Month]>, opts: { question: string; today: string; previous: unknown; all?: Array<[string, Month]>; goals?: GoalWithProgress[] }) {
  const [latestKey, latest] = months[months.length - 1];
  const h = helocCalc(latest, latestKey);
  const recentFrom = addMonths(latestKey, -2);
  const charges = months.filter(([k]) => k >= recentFrom).flatMap(([k, m]) => m.budget.expenses.map(e => ({
    month: k, date: e.date, description: e.desc, pending: e.id.startsWith('pending-'), merchant: merchantKey(e.desc), amount: Number(e.amount) || 0,
    category: m.budget.cats.find(c => c.id === e.catId)?.name ?? 'uncategorised', card: m.budget.cards.find(c => c.id === e.cardId)?.name ?? ''
  }))).sort((a, z) => a.date.localeCompare(z.date));
  return {
    format: BRIEF_FORMAT,
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    today: opts.today,
    instructions: INSTRUCTIONS,
    question: opts.question || null,
    return_format: {
      format: ADVICE_FORMAT,
      brief_generated_at: '<copy generated_at>',
      question: '<copy question, or null>',
      summary: ['Paragraph one.', 'Paragraph two.'],
      month_over_month: ['Compared with October, ...'],
      overall_progress: ['Since June, ...'],
      goal_reviews: [{ goal_id: 3, status: 'behind', comment: 'The HELOC went down $400 this month ...', next_step: 'Send the $150 left in Checking to the HELOC on the 20th.' }],
      suggested_goals: [{ kind: 'heloc_draws', title: 'No HELOC draws in January', ref: null, target: 0, due_month: null, reason: 'You drew $600 in each of the last two months.' }],
      recommendations: [{ title: 'Move the water bill to Savings', detail: 'Checking runs $140 short before the 15th deposit; ...',
        area: 'cashflow', priority: 'high', monthly_impact: null }],
      category_limits: [{ category_id: 'cat-abc', suggested_limit: 450, reason: 'Averaged $446 over the last 4 months.' }],
      watch: ['Car insurance renews in March; last renewal went up 9%.'],
      charts: [{ title: 'Card spending against limits', kind: 'bar', unit: '$', labels: ['Sep', 'Oct', 'Nov'],
        series: [{ name: 'Spent', values: [3386.58, 5055.21, 3138.44] }, { name: 'Limits', values: [2741, 2741, 2716] }],
        caption: 'October was the outlier; November is back near September.' }],
      answer: null,
      allowed_values: { area: AREAS, priority: PRIORITIES, goal_status: GOAL_STATUSES, goal_kind: Object.keys(GOAL_KINDS) }
    },
    latest_month: latestKey,
    // Every month in the planner, one row each, for month-to-month and overall comparisons.
    month_over_month: (opts.all ?? months).map(([k, m]) => monthMetrics(k, m)),
    goals: (opts.goals ?? []).map(g => ({
      goal_id: g.id, kind: g.kind, kind_label: GOAL_KINDS[g.kind].label, measures: GOAL_KINDS[g.kind].unit,
      lower_is_better: GOAL_KINDS[g.kind].lowerIsBetter, title: g.title, ref: g.ref, target: g.target, due_month: g.dueMonth,
      start_month: g.startMonth, end_month: g.endMonth, status: g.status, notes: g.notes || null,
      progress: { by_month: g.progress.series, first: g.progress.first, latest: g.progress.latest, improvement: g.progress.improvement,
        target_met: g.progress.met, trend: g.progress.trend }
    })),
    // The months in detail (bills, categories, merchants) for the window chosen.
    months: months.map(([k, m]) => monthSummary(k, m)),
    loans: latest.loans.map(l => ({ name: l.name, kind: l.kind, lender: l.lender, balance: Number(l.balance) || 0, rate_percent: Number(l.rate) || 0,
      payment: Number(l.payment) || 0, escrow: Number(l.escrow) || 0, term_months: l.term, opened: l.open, value: Number(l.value) || 0 })),
    heloc: { limit: latest.heloc.limit, rate_percent: latest.heloc.rate, balance: latest.heloc.balance, available: latest.heloc.available,
      ytd_interest: latest.heloc.ytdInterest, payment_this_month: h.thisMonth, interest_only_payment: h.io, repayment_payment: h.repayPmt },
    recent_card_charges: charges,
    previous_advice: opts.previous ?? null
  };
}

type Advice = {
  summary: string[];
  month_over_month: string[];
  overall_progress: string[];
  goal_reviews: Array<{ goal_id: number; title: string; status: string; comment: string; next_step: string }>;
  suggested_goals: Array<{ kind: GoalKind; title: string; ref: string | null; target: number | null; due_month: string | null; reason: string }>;
  recommendations: Array<{ title: string; detail: string; area: string; priority: string; monthly_impact: number | null }>;
  category_limits: Array<{ category_id: string; name: string; current_limit: number; suggested_limit: number; reason: string }>;
  watch: string[];
  answer: string | null;
  charts: Chart[];
};

export type Chart = { title: string; kind: 'bar' | 'line'; unit: '$' | '%' | ''; labels: string[]; series: Array<{ name: string; values: number[] }>; caption: string };

function readChart(x: Record<string, unknown>, where: string): Chart {
  const title = text(x.title, 120);
  if (!title) throw new Error(`${where}: no title`);
  const labels = Array.isArray(x.labels) ? x.labels.map(l => text(l, 40)) : [];
  if (labels.length < 1 || labels.length > 24) throw new Error(`${where}: needs 1-24 labels`);
  const series = (Array.isArray(x.series) ? x.series : []).slice(0, 4).map((s, i) => {
    const y = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const values = Array.isArray(y.values) ? y.values.map(Number) : [];
    if (values.length !== labels.length || values.some(v => !Number.isFinite(v) || Math.abs(v) > 1e9)) throw new Error(`${where}: series ${i + 1} needs one number per label`);
    return { name: text(y.name, 60) || `Series ${i + 1}`, values: values.map(r2) };
  });
  if (!series.length) throw new Error(`${where}: needs at least one series`);
  return { title, kind: x.kind === 'line' ? 'line' : 'bar', unit: x.unit === '%' ? '%' : x.unit === '' ? '' : '$', labels, series, caption: text(x.caption, 300) };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Check an advice file against the latest month. Bad items are dropped and reported, the rest kept. */
export function readAdvice(body: unknown, latest: Month, goals: Goal[] = []): { advice: Advice; errors: string[]; briefAt: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.format !== undefined && b.format !== ADVICE_FORMAT) throw new Error(`This file's format is ${JSON.stringify(b.format)}; the planner reads ${ADVICE_FORMAT}.`);
  const errors: string[] = [];
  const list = (k: string) => (Array.isArray(b[k]) ? b[k] as unknown[] : []);
  const summary = list('summary').map(p => text(p, 2000)).filter(Boolean).slice(0, 6);
  const recommendations: Advice['recommendations'] = [];
  list('recommendations').slice(0, 15).forEach((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const title = text(x.title, 200), detail = text(x.detail, 2000);
    if (!title) { errors.push(`Recommendation ${i + 1}: no title`); return; }
    const impact = typeof x.monthly_impact === 'number' && Number.isFinite(x.monthly_impact) && Math.abs(x.monthly_impact) < 1e6 ? r2(x.monthly_impact) : null;
    recommendations.push({ title, detail, area: AREAS.includes(x.area as never) ? x.area as string : 'other',
      priority: PRIORITIES.includes(x.priority as never) ? x.priority as string : 'medium', monthly_impact: impact });
  });
  const category_limits: Advice['category_limits'] = [];
  list('category_limits').slice(0, 40).forEach((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const cat = latest.budget.cats.find(c => c.id === x.category_id);
    const lim = Number(x.suggested_limit);
    if (!cat) { errors.push(`Category limit ${i + 1}: no category ${JSON.stringify(x.category_id)} in the latest month`); return; }
    if (!Number.isFinite(lim) || lim < 0 || lim > 1e6) { errors.push(`Category limit ${i + 1}: suggested_limit isn't a sensible amount`); return; }
    category_limits.push({ category_id: cat.id, name: cat.name, current_limit: Number(cat.limit) || 0, suggested_limit: Math.round(lim), reason: text(x.reason, 600) });
  });
  const watch = list('watch').map(w => text(w, 400)).filter(Boolean).slice(0, 8);
  const answer = text(b.answer, 6000) || null;
  const charts: Chart[] = [];
  list('charts').slice(0, 8).forEach((c, i) => {
    try { charts.push(readChart((c && typeof c === 'object' ? c : {}) as Record<string, unknown>, `Chart ${i + 1}`)); }
    catch (e) { errors.push((e as Error).message); }
  });
  const month_over_month = list('month_over_month').map(p => text(p, 2000)).filter(Boolean).slice(0, 6);
  const overall_progress = list('overall_progress').map(p => text(p, 2000)).filter(Boolean).slice(0, 6);
  const goal_reviews: Advice['goal_reviews'] = [];
  list('goal_reviews').slice(0, 40).forEach((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const g = goals.find(y => y.id === Number(x.goal_id));
    if (!g) { errors.push(`Goal review ${i + 1}: no goal ${JSON.stringify(x.goal_id)}`); return; }
    goal_reviews.push({ goal_id: g.id, title: g.title, status: GOAL_STATUSES.includes(x.status as never) ? x.status as string : 'on_track',
      comment: text(x.comment, 1500), next_step: text(x.next_step, 600) });
  });
  const suggested_goals: Advice['suggested_goals'] = [];
  list('suggested_goals').slice(0, 5).forEach((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    if (!((x.kind as string) in GOAL_KINDS)) { errors.push(`Suggested goal ${i + 1}: unknown kind ${JSON.stringify(x.kind)}`); return; }
    const t = x.target === null || x.target === undefined ? null : Number(x.target);
    suggested_goals.push({ kind: x.kind as GoalKind, title: text(x.title, 200) || GOAL_KINDS[x.kind as GoalKind].label, ref: text(x.ref, 120) || null,
      target: t !== null && Number.isFinite(t) ? r2(t) : null, due_month: isMonthKey(x.due_month) ? x.due_month : null, reason: text(x.reason, 600) });
  });
  if (!summary.length && !recommendations.length && !category_limits.length && !answer && !goal_reviews.length && !month_over_month.length)
    throw new Error('The file has no summary, recommendations, limits, goal reviews or answer.');
  const briefAt = typeof b.brief_generated_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(b.brief_generated_at) ? b.brief_generated_at : null;
  return { advice: { summary, month_over_month, overall_progress, goal_reviews, suggested_goals, recommendations, category_limits, watch, answer, charts }, errors, briefAt };
}

export function registerAdvice(app: FastifyInstance, db: Db, cfg: Config) {
  const latestAdvice = async () => (await db.query(
    `SELECT a.id, a.created_at, a.brief_at, a.question, a.body, u.name AS by FROM advice a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT 1`)).rows[0];

  app.get('/api/advice', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const q = req.query as Record<string, string>;
    const row = q.id ? (await db.query(`SELECT a.id, a.created_at, a.brief_at, a.question, a.body, u.name AS by FROM advice a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = $1`, [Number(q.id) || 0])).rows[0]
      : await latestAdvice();
    const history = (await db.query('SELECT id, created_at FROM advice ORDER BY id DESC LIMIT 24')).rows;
    return { advice: row ? { id: row.id, createdAt: new Date(row.created_at).toISOString(), briefAt: row.brief_at ? new Date(row.brief_at).toISOString() : null,
      question: row.question, by: row.by, ...row.body } : null, history: history.map(h => ({ id: h.id, createdAt: new Date(h.created_at).toISOString() })) };
  });

  /** Every month with its pending card charges counted, the way the app's own bars and alerts count them. */
  async function monthsWithPending(): Promise<Array<[string, Month]>> {
    const out: Array<[string, Month]> = [];
    for (const [k, m] of await allMonths(db)) out.push([k, withPending(m, await pendingCharges(db, k, m), k)]);
    return out;
  }

  // Month-by-month figures for the Advice tab's own charts (every month, oldest first).
  app.get('/api/advice/trends', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return { months: (await monthsWithPending()).map(([k, m]) => monthMetrics(k, m)) };
  });

  app.get('/api/advice/brief', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const q = req.query as Record<string, string>;
    const n = Math.min(24, Math.max(1, Number(q.months) || 6));
    const all = await monthsWithPending();
    if (!all.length) return reply.code(404).send({ error: 'There are no months in the planner yet.' });
    const months = all.slice(-n);
    const prev = await latestAdvice();
    const brief = buildBrief(months, { question: text(q.question, 2000), today: todayISO(cfg.tz), all, goals: await goalsWithProgress(db, all),
      previous: prev ? { date: new Date(prev.created_at).toISOString().slice(0, 10), summary: prev.body.summary,
        recommendations: (prev.body.recommendations || []).map((r: { title: string }) => r.title),
        goal_reviews: (prev.body.goal_reviews || []).map((r: { goal_id: number; status: string; next_step: string }) => ({ goal_id: r.goal_id, status: r.status, next_step: r.next_step })) } : null });
    reply.header('Content-Disposition', `attachment; filename="billplanner-brief-${todayISO(cfg.tz)}.json"`);
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/json').send(JSON.stringify(brief, null, 1));
  });

  app.post('/api/advice/import', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const keys = await listMonths(db);
    const latest = keys.length ? await loadMonth(db, keys[keys.length - 1]) : undefined;
    if (!latest) return reply.code(404).send({ error: 'There are no months in the planner yet.' });
    let read;
    try { read = readAdvice(req.body, latest, await loadGoals(db)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const q = (req.body as Record<string, unknown>)?.question;
    const question = (typeof q === 'string' && !q.startsWith('<copy') ? text(q, 2000) : '') || null;
    const row = (await db.query('INSERT INTO advice (created_by, brief_at, question, body) VALUES ($1, $2, $3, $4) RETURNING id',
      [user.id, read.briefAt, question, JSON.stringify(read.advice)])).rows[0];
    return { id: row.id, recommendations: read.advice.recommendations.length, categoryLimits: read.advice.category_limits.length,
      goalReviews: read.advice.goal_reviews.length,
      summary: read.advice.summary.length, charts: read.advice.charts.length, answered: !!read.advice.answer, errors: read.errors };
  });
}
