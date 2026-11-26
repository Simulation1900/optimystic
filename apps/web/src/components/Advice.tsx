import { useCallback, useEffect, useState } from 'react';
import { fmt, monthLabel } from '@optimystic/core';
import { api, ApiError } from '../api';
import { dispatch, toast, useStore } from '../store';
import { Goals, type GoalRow, type Review, type Suggested } from './Goals';

type Rec = { title: string; detail: string; area: string; priority: 'high' | 'medium' | 'low'; monthly_impact: number | null };
type Limit = { category_id: string; name: string; current_limit: number; suggested_limit: number; reason: string };
type Advice = {
  id: number; createdAt: string; briefAt: string | null; question: string | null; by: string | null; summary: string[]; recommendations: Rec[];
  category_limits: Limit[]; watch: string[]; answer: string | null;
  month_over_month?: string[]; overall_progress?: string[]; goal_reviews?: Review[]; suggested_goals?: Suggested[];
};
type Reply = { advice: Advice | null; history: Array<{ id: number; createdAt: string }> };
type ImportReply = { id: number; recommendations: number; categoryLimits: number; summary: number; answered: boolean; errors: string[] };

const AGENT_PROMPT = 'Read the Bill Planner brief file in this folder and follow its "instructions" exactly. Save the result next to it.';
const AREA: Record<string, string> = { cashflow: 'Cash flow', bills: 'Bills', card_budget: 'Card budget', debt: 'Debt', savings: 'Savings', other: 'Other' };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Budget advice through files: download a brief, have an agent write advice, import it here. */
export function AdviceTab() {
  const [data, setData] = useState<Reply | null>(null);
  const [months, setMonths] = useState(6);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ImportReply | null>(null);
  const load = useCallback((id?: number) => {
    api<Reply>('GET', `/api/advice${id ? `?id=${id}` : ''}`).then(setData).catch(e => toast((e as Error).message, true));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function onFile(f: File) {
    let body: unknown;
    try { body = JSON.parse(await f.text()); } catch { return toast('That file isn’t JSON. Choose the billplanner-advice-*.json file the agent wrote.', true); }
    setBusy(true);
    try {
      const r = await api<ImportReply>('POST', '/api/advice/import', { ...(body as object), question: question || undefined });
      setLast(r); load(); toast('Advice imported.');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Couldn’t import that file.', true); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(AGENT_PROMPT); toast('Copied.'); } catch { toast(AGENT_PROMPT); }
  }
  const href = `/api/advice/brief?${new URLSearchParams({ months: String(months), ...(question.trim() ? { question: question.trim() } : {}) })}`;
  const a = data?.advice;
  const [goals, setGoals] = useState<GoalRow[] | null>(null);
  const loadGoals = useCallback(() => { api<{ goals: GoalRow[] }>('GET', '/api/goals').then(r => setGoals(r.goals)).catch(e => toast((e as Error).message, true)); }, []);
  useEffect(() => { loadGoals(); }, [loadGoals]);
  return (
    <>
      <Goals goals={goals} setGoals={setGoals} reviews={a?.goal_reviews ?? []} suggested={a?.suggested_goals ?? []} />
      <div className="hhead" style={{ marginBottom: 18 }}><div><div className="eyebrow">Budget advice</div><h2>{a ? `Advice from ${day(a.createdAt)}` : 'Get budgeting advice'}</h2></div>
        {data && data.history.length > 1 && (
          <select className="mini" aria-label="Earlier advice" value={a?.id ?? ''} onChange={e => load(Number(e.target.value))}>
            {data.history.map(h => <option key={h.id} value={h.id}>{day(h.createdAt)}</option>)}
          </select>
        )}
      </div>
      {a ? <AdviceView a={a} /> : data && <p className="hnote">No advice yet. Download a brief below, give it to an agent, and import what it writes.</p>}
      <div className="settings" style={{ marginTop: 18 }}>
        <div className="hcard">
          <h3>1. Download a brief</h3>
          <p className="hnote">Your accounts, bills, transfers, loans, HELOC and card spending (with every charge from the last three months) for the months you choose. It’s your private financial data: keep the file to yourself and the agent you give it to.</p>
          <label className="hnote" style={{ display: 'grid', gap: 4, marginTop: 10 }}>Months to include
            <select value={months} onChange={e => setMonths(Number(e.target.value))}>{[3, 6, 12].map(n => <option key={n} value={n}>Last {n} months</option>)}</select></label>
          <label className="hnote" style={{ display: 'grid', gap: 4, marginTop: 10 }}>A question for the advisor (optional)
            <textarea rows={3} value={question} maxLength={2000} onChange={e => setQuestion(e.target.value)} placeholder="Can we pay the car off early? Where is the grocery money going?" /></label>
          <a className="pbtn" style={{ marginLeft: 0, marginTop: 12, display: 'inline-block', textDecoration: 'none' }} href={href} download>Download brief</a>
        </div>
        <div className="hcard">
          <h3>2. Give it to an agent</h3>
          <p className="hnote">Put the brief in a folder and start an agent there, for example Claude Code on your Claude plan, with this prompt. It writes a <code>billplanner-advice-….json</code> file next to the brief.</p>
          <p className="hnote" style={{ fontFamily: 'var(--mono, monospace)' }}>{AGENT_PROMPT}</p>
          <button className="mini" onClick={copy}>Copy prompt</button>
        </div>
        <div className="hcard">
          <h3>3. Import the advice</h3>
          <p className="hnote">Nothing changes in the planner on import. Suggested category limits get an Apply button.</p>
          <label className="pbtn" style={{ marginLeft: 0, marginTop: 12, display: 'inline-block', cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Importing…' : 'Choose advice file'}
            <input type="file" accept=".json,application/json" hidden disabled={busy} data-testid="advice-input" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} /></label>
          {last && (
            <p className="hnote" style={{ marginTop: 10 }}>{last.recommendations} recommendations, {last.categoryLimits} limit suggestions{last.answered ? ', and an answer to your question' : ''}.
              {last.errors.length > 0 && <> Skipped: {last.errors.join('; ')}.</>}</p>
          )}
        </div>
      </div>
    </>
  );
}

function AdviceView({ a }: { a: Advice }) {
  const month = useStore(s => s.month), key = useStore(s => s.key);
  const order = { high: 0, medium: 1, low: 2 };
  const recs = [...a.recommendations].sort((x, y) => order[x.priority] - order[y.priority]);
  const freed = recs.reduce((t, r) => t + (r.monthly_impact && r.monthly_impact > 0 ? r.monthly_impact : 0), 0);
  function apply(l: Limit) {
    const cat = month?.budget.cats.find(c => c.id === l.category_id);
    if (!cat) return toast(`${key ? monthLabel(key) : 'This month'} has no “${l.name}” category.`, true);
    try { dispatch({ type: 'cat.update', id: cat.id, version: cat.version, patch: { limit: l.suggested_limit } }); toast(`${l.name} limit set to ${fmt(l.suggested_limit)} in ${monthLabel(key)}.`); }
    catch (e) { toast((e as Error).message, true); }
  }
  return (
    <div className="advice">
      {a.question && a.answer && (
        <div className="hcard"><h3>Your question</h3><p className="hnote"><i>{a.question}</i></p>{a.answer.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}</div>
      )}
      {a.summary.length > 0 && <div className="hcard"><h3>Where you stand</h3>{a.summary.map((p, i) => <p key={i}>{p}</p>)}</div>}
      {!!a.month_over_month?.length && <div className="hcard"><h3>Compared with last month</h3>{a.month_over_month.map((p, i) => <p key={i}>{p}</p>)}</div>}
      {!!a.overall_progress?.length && <div className="hcard"><h3>Overall progress</h3>{a.overall_progress.map((p, i) => <p key={i}>{p}</p>)}</div>}
      {recs.length > 0 && (
        <div className="hcard">
          <h3>Recommendations{freed > 0 ? ` · up to ${fmt(freed)}/month` : ''}</h3>
          <ol className="recs">
            {recs.map((r, i) => (
              <li key={i} className={`rec ${r.priority}`}>
                <div className="rech"><b>{r.title}</b><span className="tagp">{AREA[r.area] ?? r.area} · {r.priority}</span>{r.monthly_impact ? <span className="num pos">{r.monthly_impact > 0 ? '+' : ''}{fmt(r.monthly_impact)}/mo</span> : null}</div>
                {r.detail && <p>{r.detail}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {a.category_limits.length > 0 && (
        <div className="hcard">
          <h3>Suggested card budget limits</h3>
          <p className="hnote">Apply sets the limit in the month you have open ({key ? monthLabel(key) : '—'}). New months copy it forward.</p>
          <table className="limits">
            <thead><tr><th>Category</th><th className="num">Now</th><th className="num">Suggested</th><th>Why</th><th /></tr></thead>
            <tbody>{a.category_limits.map(l => {
              const now = Number(month?.budget.cats.find(c => c.id === l.category_id)?.limit ?? l.current_limit);
              return (
                <tr key={l.category_id}>
                  <td>{l.name}</td><td className="num">{fmt(now)}</td><td className="num">{fmt(l.suggested_limit)}</td><td className="hnote">{l.reason}</td>
                  <td>{Math.round(now) === l.suggested_limit ? <span className="hnote">Applied</span> : <button className="mini" onClick={() => apply(l)}>Apply</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {a.watch.length > 0 && <div className="hcard"><h3>Keep an eye on</h3><ul>{a.watch.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
    </div>
  );
}
