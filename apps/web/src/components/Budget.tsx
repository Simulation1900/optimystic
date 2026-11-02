import { useRef, useState, type FormEvent } from 'react';
import { cents, fmt, guessCat, rememberedCat, monthBounds, monthLabel, monthPace, r2, shortDate, uid, type CardExpense, type Month } from '@optimystic/core';
import { api } from '../api';
import { dispatch, flush, getState, openMonth, toast, useDerived, useStore } from '../store';
import { ask, Field, Modal, money2 } from '../ui';

const run = (f: () => void) => { try { f(); } catch (e) { toast((e as Error).message, true); } };

export function BudgetTab() {
  const month = useStore(s => s.month)!, key = useStore(s => s.key), today = useStore(s => s.today);
  const st = useDerived()!.budget;
  const b = month.budget, pace = monthPace(key, today);
  const saving = r2((Number(b.baseline) || 0) - st.projected);
  const [quick, setQuick] = useState(false);
  const pending = useStore(s => (s.server?.key === key ? s.server.pending : undefined)) || [];
  const pendingTotal = r2(pending.reduce((t, p) => t + p.amount, 0));
  return (
    <section id="budget">
      <div className="hhead">
        <div><div className="eyebrow">Credit cards · calendar month</div><h2>Card budget</h2></div>
        <div className="hsub">Expenses logged here become next month’s card bills when you start a new month.</div>
      </div>
      <SyncLine />
      <div className="bsum">
        <div className="stat"><div className="k">Spent this month</div><div className="v num" data-testid="budget-spent">{fmt(st.spent)}</div><div className="sub">{b.expenses.length} expenses{pendingTotal ? <> · <span data-testid="pending-total">+{fmt(pendingTotal)} pending</span></> : null}</div></div>
        <div className="stat"><div className="k">Budget</div><div className="v num">{fmt(st.limit)}</div><div className="sub">{b.cats.length} categories</div></div>
        <div className="stat"><div className="k">Left to spend</div><div className={`v num ${st.left < 0 ? 'neg' : ''}`}>{fmt(st.left)}</div>
          <div className="sub">{pace > 0 && pace < 1 ? Math.round(pace * 100) + '% of the month gone' : pace >= 1 ? 'month is over' : 'month hasn’t started'}</div></div>
        <div className="stat"><div className="k">Card bills next month</div><div className="v num">{fmt(st.projected)}</div><div className="sub">spent + rest of each budget</div></div>
        <div className="stat"><div className="k">Vs. before the budget</div><div className={`v num ${saving >= 0 ? 'pos' : 'neg'}`}>{saving >= 0 ? '' : '−'}{fmt(Math.abs(saving))}</div>
          <div className="sub">a month, vs. <Field inputMode="decimal" aria-label="Typical monthly card spending before the budget" value={b.baseline} format={v => (Number(v) || 0).toFixed(0)}
            style={{ width: 62, border: 'none', borderBottom: '1px dashed var(--faint)', background: 'transparent', font: 'inherit', color: 'inherit' }}
            onCommit={v => run(() => dispatch({ type: 'budget.update', version: month.meta?.version, patch: { baseline: v } }))} /> average</div></div>
      </div>
      <div className="bcards">
        {st.cards.map(c => {
          const pct = c.budget > 0 ? Math.min(100, c.spent / c.budget * 100) : 0;
          return (
            <div key={c.id} className="hcard bcard" style={{ ['--c' as string]: c.color || 'var(--accent)' }}>
              <div className="optname"><span className="dot" style={{ background: c.color || 'var(--accent)' }} />{c.name}</div>
              <div className="big num" style={{ marginTop: 8 }}>{fmt(c.spent)}</div>
              <div className="hnote">spent of {fmt(c.budget)} budgeted this month</div>
              <div className={`pace ${c.spent > c.budget ? 'over' : ''}`}><i style={{ width: pct + '%' }} />{pace > 0 && pace < 1 && <b style={{ left: pace * 100 + '%' }} title="Where you'd be at an even pace" />}</div>
              <div className="kv"><span>Projected bill</span><b className="num">{fmt(c.projected)}</b></div>
              <div className="hnote">{c.billName ? `Becomes “${c.billName}” next month` : 'Not linked to a bill'}</div>
            </div>
          );
        })}
      </div>
      <div className="bgrid">
        <Categories month={month} />
        <div>
          <div className="hcard addcard">
            <h3>Add an expense</h3>
            <AddExpense month={month} mkey={key} today={today} />
          </div>
          <div className="hcard csvcard">
            <CsvImport month={month} mkey={key} />
            <div className="hdiv" />
            <Cards month={month} />
          </div>
        </div>
      </div>
      <Expenses month={month} mkey={key} />
      <button className="fab" aria-label="Add an expense" onClick={() => setQuick(true)}>+</button>
      {quick && (
        <Modal sheet onClose={() => setQuick(false)} label="Add an expense">
          <h3>Add an expense</h3>
          <AddExpense month={month} mkey={key} today={today} onDone={() => setQuick(false)} autoFocus />
        </Modal>
      )}
    </section>
  );
}

function Categories({ month }: { month: Month }) {
  const b = month.budget, st = useDerived()!.budget;
  return (
    <div className="hcard">
      <h3>Categories</h3>
      <table className="btable cattable"><thead><tr><th>Category</th><th className="hide-sm">Card</th><th className="r">Limit</th><th className="r">Spent</th><th className="r">Left</th><th className="hide-sm" /><th /></tr></thead>
        <tbody>{b.cats.map(k => {
          const sp = r2(st.byCat[k.id] || 0), lim = Number(k.limit) || 0, left = r2(lim - sp);
          const pct = lim > 0 ? Math.min(100, sp / lim * 100) : (sp > 0 ? 100 : 0);
          return (
            <tr key={k.id} data-cat={k.name}>
              <td><Field aria-label="Category name" value={k.name} onCommit={v => run(() => dispatch({ type: 'cat.update', id: k.id, version: k.version, patch: { name: v } }))} />
                <div className={`minibar phone-only ${sp > lim ? 'over' : ''}`} aria-hidden="true"><i style={{ width: pct + '%' }} /></div></td>
              <td className="hide-sm"><select aria-label={`${k.name} card`} value={k.cardId} onChange={e => run(() => dispatch({ type: 'cat.update', id: k.id, version: k.version, patch: { cardId: e.target.value } }))}>
                {b.cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
              <td className="r"><Field className="r lim" inputMode="decimal" aria-label={`${k.name} monthly limit`} value={lim} format={money2}
                onCommit={v => run(() => dispatch({ type: 'cat.update', id: k.id, version: k.version, patch: { limit: v } }))} /></td>
              <td className="r num">{fmt(sp)}</td>
              <td className={`r num ${left < 0 ? 'neg' : ''}`}>{fmt(left)}</td>
              <td className="hide-sm" style={{ width: '18%' }}><div className={`minibar ${sp > lim ? 'over' : ''}`} role="progressbar" aria-label={`${k.name} spent`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: pct + '%' }} /></div></td>
              <td><button className="x" title="Remove category" aria-label={`Remove ${k.name}`} onClick={async () => {
                const n = b.expenses.filter(x => x.catId === k.id).length;
                const other = b.cats.find(x => x.name.toLowerCase() === 'other' && x.id !== k.id);
                if (await ask(`Remove “${k.name}”?${n ? `\n\nIts ${n} expense(s) move to ${other ? '“Other”' : 'the first category'}.` : ''}`, 'Remove'))
                  run(() => dispatch({ type: 'cat.remove', id: k.id, version: k.version }));
              }}>×</button></td>
            </tr>
          );
        })}</tbody>
        <tfoot><tr><td><b>Total</b></td><td className="hide-sm" /><td className="r num"><b>{fmt(st.limit)}</b></td><td className="r num"><b>{fmt(st.spent)}</b></td><td className={`r num ${st.left < 0 ? 'neg' : ''}`}><b>{fmt(st.left)}</b></td><td className="hide-sm" /><td /></tr></tfoot>
      </table>
      <button className="linkbtn" onClick={() => run(() => dispatch({ type: 'cat.add', id: 'cat-' + uid(), cardId: b.cards[0]?.id }))}>+ Add category</button>
    </div>
  );
}

function AddExpense({ month, mkey, today, onDone, autoFocus }: { month: Month; mkey: string; today: string; onDone?: () => void; autoFocus?: boolean }) {
  const b = month.budget, { first, last } = monthBounds(mkey);
  const dflt = today >= first && today <= last ? today : first;
  const cardFor = (catId: string) => b.cats.find(x => x.id === catId)?.cardId || b.cards[0]?.id || '';
  const [desc, setDesc] = useState(''), [amt, setAmt] = useState(''), [date, setDate] = useState(dflt);
  const [cat, setCat] = useState(b.cats[0]?.id || ''), [card, setCard] = useState(cardFor(b.cats[0]?.id || ''));
  const touched = useRef(false);
  const descRef = useRef<HTMLInputElement>(null);
  const memory = useStore(s => s.server?.catMemory);
  const [fromPast, setFromPast] = useState<string | null>(null);
  function onDesc(v: string) {
    setDesc(v);
    if (touched.current) return;
    // Past choices for this merchant come first, then the keyword rules.
    const past = rememberedCat(v, b, memory);
    setFromPast(past ? past.name : null);
    const k = past || guessCat(v, b);
    if (k) { setCat(k.id); setCard(k.cardId || card); }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = cents(amt);
    if (!desc.trim() || !amount || !date) return;
    try {
      dispatch({ type: 'expense.add', id: uid(), date, desc: desc.trim(), amount, catId: cat, cardId: card });
      setDesc(''); setAmt(''); touched.current = false; setFromPast(null);
      onDone ? onDone() : descRef.current?.focus();
    } catch (err) { toast((err as Error).message, true); }
  }
  return (
    <form className="addexp" autoComplete="off" onSubmit={submit}>
      <div className="full"><label htmlFor={`bDesc${onDone ? 'q' : ''}`}>Description</label><input ref={descRef} id={`bDesc${onDone ? 'q' : ''}`} placeholder="e.g. Kroger" required autoFocus={autoFocus} value={desc} onChange={e => onDesc(e.target.value)} /></div>
      <div><label htmlFor={`bAmt${onDone ? 'q' : ''}`}>Amount</label><input id={`bAmt${onDone ? 'q' : ''}`} inputMode="decimal" placeholder="0.00" required value={amt} onChange={e => setAmt(e.target.value)} /></div>
      <div><label htmlFor={`bDate${onDone ? 'q' : ''}`}>Date</label><input type="date" id={`bDate${onDone ? 'q' : ''}`} min={first} max={last} required value={date} onChange={e => setDate(e.target.value)} /></div>
      <div><label htmlFor={`bCat${onDone ? 'q' : ''}`}>Category</label><select id={`bCat${onDone ? 'q' : ''}`} value={cat} onChange={e => { touched.current = true; setFromPast(null); setCat(e.target.value); setCard(cardFor(e.target.value)); }}>
        {b.cats.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
        {fromPast && <div className="hnote" data-testid="cat-from-past" style={{ marginTop: 4 }}>Suggested from your past purchases at this store</div>}</div>
      <div><label htmlFor={`bCard${onDone ? 'q' : ''}`}>Card</label><select id={`bCard${onDone ? 'q' : ''}`} value={card} onChange={e => setCard(e.target.value)}>
        {b.cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="full"><button className="pbtn wide" type="submit" style={{ marginTop: 4 }}>Add expense</button></div>
    </form>
  );
}

function CsvImport({ month, mkey }: { month: Month; mkey: string }) {
  const b = month.budget;
  const [card, setCard] = useState(b.cards[0]?.id || '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function onFile(f: File) {
    setBusy(true); setStatus('Reading…');
    try {
      await flush();
      const r = await api<{ message: string }>('POST', '/api/budget/import', { card, csv: await f.text(), month: mkey });
      setStatus(r.message);
      await openMonth(getState().key);
    } catch (e) { setStatus((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="settings-label">Import a card download (CSV)</div>
      <div className="btools">
        <select aria-label="Card the file is from" value={card} onChange={e => setCard(e.target.value)}>{b.cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <label className="mini" style={{ cursor: busy ? 'wait' : 'pointer' }}>Choose CSV<input type="file" accept=".csv,text/csv" hidden disabled={busy} data-testid="csv-input"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} /></label>
      </div>
      <div className="hnote">Payments are skipped, returns count as credits, and each line is filed in the month of its date. Lines already logged aren’t added twice. Lines from a month that isn’t in the planner yet are skipped.</div>
      <div className={`bstatus ${status.startsWith('✓') ? 'ok' : ''}`} role="status" data-testid="csv-status">{status}</div>
    </>
  );
}

function Cards({ month }: { month: Month }) {
  const b = month.budget, billNames = [...new Set(month.bills.map(x => x.name))];
  return (
    <>
      <h3>Cards</h3>
      <table className="btable"><thead><tr><th>Card</th><th>Becomes this bill</th><th /></tr></thead>
        <tbody>{b.cards.map(c => (
          <tr key={c.id}>
            <td><Field aria-label="Card name" value={c.name} onCommit={v => run(() => dispatch({ type: 'card.update', id: c.id, version: c.version, patch: { name: v } }))} /></td>
            <td><select aria-label={`${c.name} bill`} value={c.billName} onChange={e => run(() => dispatch({ type: 'card.update', id: c.id, version: c.version, patch: { billName: e.target.value } }))}>
              <option value="">(no bill)</option>
              {billNames.concat(c.billName && !billNames.includes(c.billName) ? [c.billName] : []).map(n => <option key={n} value={n}>{n}</option>)}
            </select></td>
            <td><button className="x" title="Remove card" aria-label={`Remove ${c.name}`} onClick={async () => {
              if (b.cards.length <= 1) return toast('Keep at least one card.', true);
              const to = b.cards.find(x => x.id !== c.id)!;
              if (await ask(`Remove “${c.name}”? Its expenses and categories move to “${to.name}”.`, 'Remove')) run(() => dispatch({ type: 'card.remove', id: c.id, version: c.version }));
            }}>×</button></td>
          </tr>
        ))}</tbody></table>
      <button className="linkbtn" onClick={() => run(() => dispatch({ type: 'card.add', id: 'card-' + uid() }))}>+ Add card</button>
    </>
  );
}

function Expenses({ month, mkey }: { month: Month; mkey: string }) {
  const b = month.budget;
  const [group, setGroup] = useState<'date' | 'cat' | 'card'>('date');
  const [fCat, setFCat] = useState(''), [fCard, setFCard] = useState('');
  const ex = b.expenses.filter(e => (!fCat || e.catId === fCat) && (!fCard || e.cardId === fCard))
    .slice().sort((x, y) => y.date.localeCompare(x.date) || y.id.localeCompare(x.id));
  const row = (e: CardExpense) => (
    <tr key={e.id}>
      <td className="num">{shortDate(e.date)}</td>
      <td><Field aria-label="Description" value={e.desc} onCommit={v => run(() => dispatch({ type: 'expense.update', id: e.id, version: e.version, patch: { desc: v } }))} /></td>
      <td className="hide-sm"><select aria-label={`${e.desc} category`} value={e.catId} onChange={x => run(() => dispatch({ type: 'expense.update', id: e.id, version: e.version, patch: { catId: x.target.value } }))}>
        {b.cats.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></td>
      <td className="hide-sm"><select aria-label={`${e.desc} card`} value={e.cardId} onChange={x => run(() => dispatch({ type: 'expense.update', id: e.id, version: e.version, patch: { cardId: x.target.value } }))}>
        {b.cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
      <td className="r"><Field className="r lim" inputMode="decimal" aria-label={`${e.desc} amount`} value={e.amount} format={money2}
        onCommit={v => run(() => dispatch({ type: 'expense.update', id: e.id, version: e.version, patch: { amount: v } }))} /></td>
      <td><button className="x" title="Delete expense" aria-label={`Delete ${e.desc}`} onClick={() => run(() => dispatch({ type: 'expense.remove', id: e.id, version: e.version }))}>×</button></td>
    </tr>
  );
  const pend = (useStore(s => (s.server?.key === mkey ? s.server.pending : undefined)) || []).filter(p => !fCard || p.cardId === fCard);
  const cardName = (id: string) => b.cards.find(c => c.id === id)?.name || '';
  // Pending charges sit on top, greyed: not in any total until they post (their id and amount can change).
  const pendRows = fCat ? [] : pend.map(p => (
    <tr key={'p' + p.id} className="pendrow" data-testid="pending-row">
      <td className="num">{shortDate(p.date)}</td>
      <td>{p.desc} <span className="tag">Pending</span></td>
      <td className="hide-sm hnote">not counted yet</td>
      <td className="hide-sm">{cardName(p.cardId)}</td>
      <td className="r num">{fmt(p.amount)}</td><td />
    </tr>
  ));
  let body;
  if (!ex.length) body = <tr><td colSpan={6} className="hnote" style={{ padding: '18px 6px' }}>No expenses {b.expenses.length ? 'match the filter' : `logged for ${monthLabel(mkey)} yet`}.</td></tr>;
  else if (group === 'date') body = ex.map(row);
  else {
    const groups = group === 'cat' ? b.cats.map(k => [k.id, k.name]) : b.cards.map(c => [c.id, c.name]);
    const field = group === 'cat' ? 'catId' : 'cardId';
    body = groups.map(([id, name]) => {
      const rows = ex.filter(e => e[field] === id);
      if (!rows.length) return null;
      const tot = r2(rows.reduce((t, e) => t + (Number(e.amount) || 0), 0));
      return [<tr className="grp" key={'g' + id}><td colSpan={4}>{name} · {rows.length}</td><td className="r num">{fmt(tot)}</td><td /></tr>, ...rows.map(row)];
    });
  }
  return (
    <div className="hcard">
      <div className="charthead"><h3>Expenses in {monthLabel(mkey)}</h3>
        <div className="btools">
          <select aria-label="Sort" value={group} onChange={e => setGroup(e.target.value as 'date')}><option value="date">Newest first</option><option value="cat">Group by category</option><option value="card">Group by card</option></select>
          <select aria-label="Filter by category" value={fCat} onChange={e => setFCat(e.target.value)}><option value="">All categories</option>{b.cats.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
          <select aria-label="Filter by card" value={fCard} onChange={e => setFCard(e.target.value)}><option value="">All cards</option>{b.cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div></div>
      <div className="bscroll"><table className="btable exptable"><thead><tr><th>Date</th><th>Description</th><th className="hide-sm">Category</th><th className="hide-sm">Card</th><th className="r">Amount</th><th /></tr></thead><tbody>{pendRows}{body}</tbody></table></div>
    </div>
  );
}

/** Card sync status on the Card budget tab, with Sync now. Hidden until card sync is connected. */
function SyncLine() {
  const sync = useStore(s => s.server?.sync);
  const [busy, setBusy] = useState(false);
  if (!sync?.connected) return null;
  async function run() {
    setBusy(true);
    try {
      await flush();
      const r = await api<{ lastResult: { message: string } | null; lastError: string | null }>('POST', '/api/sync/run');
      await openMonth(getState().key);
      if (r.lastError) toast(r.lastError, true); else if (r.lastResult) toast(r.lastResult.message);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const when = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  return (
    <div className={`banner ${sync.lastError ? 'warnbanner' : ''}`} data-testid="sync-line">
      <span className="grow">{sync.lastError ? <><b>Card sync needs attention.</b> {sync.lastError}</> : <>Cards synced {when}.</>}</span>
      <button className="mini" onClick={run} disabled={busy}>{busy ? 'Syncing…' : 'Sync now'}</button>
    </div>
  );
}
