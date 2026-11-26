import { useState, type FormEvent } from 'react';
import { fmt, GOAL_KINDS, monthLabel, shortLabel, type Goal, type GoalKind, type GoalProgress, type Month } from '@optimystic/core';
import { api, ApiError } from '../api';
import { ask } from '../ui';
import { toast, useStore } from '../store';

export type GoalRow = Goal & { progress: GoalProgress };
export type Review = { goal_id: number; title: string; status: string; comment: string; next_step: string };
export type Suggested = { kind: GoalKind; title: string; ref: string | null; target: number | null; due_month: string | null; reason: string };
const REVIEW: Record<string, string> = { on_track: 'On track', ahead: 'Ahead', behind: 'Behind', at_risk: 'At risk', done: 'Done' };
const TREND: Record<string, string> = { better: '▲ better', worse: '▼ worse', flat: 'no change', none: '' };

/** Goals carry over month to month until done or dropped; each one's measure comes from the months themselves. */
export function Goals({ goals, setGoals, reviews, suggested }: { goals: GoalRow[] | null; setGoals: (g: GoalRow[]) => void; reviews: Review[]; suggested: Suggested[] }) {
  const key = useStore(s => s.key), month = useStore(s => s.month);
  const [adding, setAdding] = useState<Partial<Suggested> | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  async function call(method: string, url: string, body?: unknown) {
    try { const r = await api<{ goals: GoalRow[] }>(method, url, body); setGoals(r.goals); return true; }
    catch (e) { toast(e instanceof ApiError ? e.message : (e as Error).message, true); return false; }
  }
  if (!goals) return null;
  const active = goals.filter(g => g.status === 'active'), ended = goals.filter(g => g.status !== 'active');
  const fresh = suggested.filter(s => !active.some(g => g.kind === s.kind && (g.ref ?? '') === (s.ref ?? '')));

  const card = (g: GoalRow) => {
    const def = GOAL_KINDS[g.kind], p = g.progress, rv = reviews.find(r => r.goal_id === g.id);
    const pts = p.series.filter(s => s.value !== null).slice(-6) as Array<{ key: string; value: number }>;
    return (
      <div key={g.id} className={`goal ${g.status}`} data-goal={g.title}>
        <div className="rech">
          <b>{g.title}</b>
          {rv && g.status === 'active' && <span className={`tagp gs-${rv.status}`}>{REVIEW[rv.status] ?? rv.status}</span>}
          {g.status !== 'active' && <span className="tagp">{g.status === 'done' ? `Done${g.endMonth ? ` ${shortLabel(g.endMonth)}` : ''}` : 'Dropped'}</span>}
          {p.met && g.status === 'active' && g.kind !== 'custom' && <span className="tagp gs-ahead">Target reached</span>}
        </div>
        <div className="hnote">
          {g.kind === 'custom' ? 'Mark it done when it is.' : <>
            {def.unit}: <b className="num">{p.latest === null ? '—' : fmt(p.latest)}</b>
            {g.target !== null && <> · target {def.lowerIsBetter ? 'at most' : 'at least'} <span className="num">{fmt(g.target)}</span></>}
            {g.dueMonth && <> by {monthLabel(g.dueMonth)}</>}
            {p.improvement !== null && pts.length > 1 && <> · <span className={p.trend === 'worse' ? 'neg' : p.trend === 'better' ? 'pos' : ''}>{TREND[p.trend]} {fmt(Math.abs(p.improvement))} since {shortLabel(pts[0].key)}</span></>}
          </>}
          <span> · set {shortLabel(g.startMonth)}</span>
        </div>
        {pts.length > 1 && <div className="spark num">{pts.map(s => <span key={s.key}><i>{shortLabel(s.key)}</i>{fmt(s.value)}</span>)}</div>}
        {rv && g.status === 'active' && <p className="hnote" style={{ marginTop: 6 }}>{rv.comment}{rv.next_step && <><br /><b>Next:</b> {rv.next_step}</>}</p>}
        <div className="goalacts">
          {g.status === 'active' ? <>
            <button className="mini" onClick={() => call('PATCH', `/api/goals/${g.id}`, { status: 'done', month: key })}>Mark done</button>
            <button className="mini" onClick={() => call('PATCH', `/api/goals/${g.id}`, { status: 'dropped', month: key })}>Drop</button>
          </> : <button className="mini" onClick={() => call('PATCH', `/api/goals/${g.id}`, { status: 'active' })}>Reopen</button>}
          <button className="mini" onClick={async () => { if (await ask(`Delete the goal “${g.title}”?`, 'Delete')) void call('DELETE', `/api/goals/${g.id}`); }}>Delete</button>
        </div>
      </div>
    );
  };

  return (
    <div className="hcard goals" style={{ marginBottom: 18 }}>
      <div className="rech" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Goals</h3>
        {!adding && <button className="mini" onClick={() => setAdding({})}>Add a goal</button>}
      </div>
      <p className="hnote">A goal starts in {key ? monthLabel(key) : 'this month'} and carries over every month until you mark it done or drop it. Progress is measured from your months, and the advice reviews each goal.</p>
      {adding && <GoalForm initial={adding} month={month} onCancel={() => setAdding(null)}
        onSave={async body => { if (await call('POST', '/api/goals', { ...body, startMonth: key })) setAdding(null); }} />}
      {active.length ? active.map(card) : !adding && <p className="hnote">No goals yet. Try “Pay down the HELOC” or “Grow savings”.</p>}
      {fresh.length > 0 && (
        <div className="suggest">
          <p className="hnote" style={{ margin: 0 }}><b>Suggested by the latest advice</b></p>
          {fresh.map((s, i) => (
            <div key={i} className="rech">
              <span>{s.title}{s.target !== null ? ` (${fmt(s.target)})` : ''} <span className="hnote">— {s.reason}</span></span>
              <button className="mini" onClick={() => setAdding(s)}>Set this goal</button>
            </div>
          ))}
        </div>
      )}
      {ended.length > 0 && <button className="linkbtn" onClick={() => setShowEnded(!showEnded)}>{showEnded ? 'Hide' : 'Show'} {ended.length} finished or dropped</button>}
      {showEnded && ended.map(card)}
    </div>
  );
}

function GoalForm({ initial, month, onCancel, onSave }: { initial: Partial<Suggested>; month: Month | null; onCancel: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [kind, setKind] = useState<GoalKind>(initial.kind ?? 'heloc_balance');
  const def = GOAL_KINDS[kind];
  const refs = def.needsRef === 'loan' ? (month?.loans ?? []).map(l => l.name) : def.needsRef === 'account' ? (month?.accounts ?? []).map(a => a.name) : [];
  const [ref, setRef] = useState(initial.ref ?? '');
  const [target, setTarget] = useState(initial.target != null ? String(initial.target) : def.defaultTarget !== null ? String(def.defaultTarget) : '');
  const [due, setDue] = useState(initial.due_month ?? '');
  const [title, setTitle] = useState(initial.title ?? '');
  function submit(e: FormEvent) {
    e.preventDefault();
    onSave({ kind, ref: def.needsRef ? (ref || refs[0] || '') : null, target: kind === 'custom' ? null : target, dueMonth: due || null, title: title.trim() || undefined });
  }
  return (
    <form className="form goalform" onSubmit={submit}>
      <label htmlFor="g-kind">Goal</label>
      <select id="g-kind" value={kind} onChange={e => { const k = e.target.value as GoalKind; setKind(k); setRef(''); setTarget(GOAL_KINDS[k].defaultTarget !== null ? String(GOAL_KINDS[k].defaultTarget) : ''); }}>
        {(Object.keys(GOAL_KINDS) as GoalKind[]).map(k => <option key={k} value={k}>{GOAL_KINDS[k].label}</option>)}
      </select>
      {def.needsRef && <>
        <label htmlFor="g-ref">{def.needsRef === 'loan' ? 'Loan' : 'Account'}</label>
        <select id="g-ref" value={ref || refs[0] || ''} onChange={e => setRef(e.target.value)}>{refs.map(r => <option key={r}>{r}</option>)}</select>
      </>}
      {kind !== 'custom' && <>
        <label htmlFor="g-target">{def.lowerIsBetter ? `Get ${def.unit} down to ($)` : `Get ${def.unit} up to ($)`}</label>
        <input id="g-target" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} placeholder="0" required={kind === 'savings'} />
      </>}
      <label htmlFor="g-due">By (optional)</label>
      <input id="g-due" type="month" value={due} onChange={e => setDue(e.target.value)} />
      <label htmlFor="g-title">Name (optional)</label>
      <input id="g-title" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder={def.label} />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button className="pbtn" style={{ marginLeft: 0 }}>Save goal</button>
        <button type="button" className="mini" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
