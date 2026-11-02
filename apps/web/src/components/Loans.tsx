import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  addMonths, clone, customWarning, fmt, helocCalc, loanCalc, mIdx, monthLabel, r2, shortLabel, shortfalls, sum, uid, billsFor, cents,
  type HelocCalc, type Loan, type LoanCalc, type LoanPlan, type Month
} from '@optimystic/core';
import { dispatch, getState, toast, useStore } from '../store';
import { ask, Field, money2, moneyOrBlank } from '../ui';
import { coverWithTransfer } from './Transfers';

const run = (f: () => void) => { try { f(); } catch (e) { toast((e as Error).message, true); } };
const OPT_COLORS: Record<string, string> = { min: 'var(--faint)', draw: '#4f80a8', y5: '#c0834f', y3: '#5c8a72', custom: '#8a6fae' };
const LOAN_COLORS: Record<string, string> = { cur: '#4f80a8', b0: '#c0834f', b1: '#5c8a72', custom: '#8a6fae', value: '#b8913a' };
const k$ = (v: number) => (v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : fmt(v));

export function LoansTab() {
  const month = useStore(s => s.month)!, key = useStore(s => s.key);
  return (
    <>
      <Heloc month={month} mkey={key} />
      <section className="heloc loans">
        <div className="hhead"><div><div className="eyebrow">Cars &amp; home</div><h2>Loans</h2></div>
          <button className="tbtn" onClick={() => run(() => dispatch({ type: 'loan.add', id: uid() }))}>+ Add loan</button></div>
        {month.loans.map(l => <LoanCard key={l.id} loan={l} month={month} mkey={key} />)}
        {!month.loans.length && <div className="hempty">No loans yet.</div>}
      </section>
    </>
  );
}

/* ---------------- HELOC ---------------- */
function Heloc({ month, mkey }: { month: Month; mkey: string }) {
  const h = month.heloc;
  // While the rate slider moves, preview locally; save once it settles.
  const [rate, setRate] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shown = useMemo(() => { if (rate === null) return month; const m = clone(month); m.heloc.rate = rate; return m; }, [month, rate]);
  const c = helocCalc(shown, mkey);
  const setRateLive = (v: string) => {
    const n = Math.max(0, parseFloat(v) || 0);
    setRate(n);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { run(() => dispatch({ type: 'heloc.update', version: getState().month?.heloc.version, patch: { rate: n } })); setRate(null); }, 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const upd = (k: string, v: unknown) => run(() => dispatch({ type: 'heloc.update', version: h.version, patch: { [k]: v } }));
  const diff = r2((Number(h.balance) || 0) + (Number(h.available) || 0) - (Number(h.limit) || 0));
  const year = mkey.slice(0, 4);
  const shownRate = rate ?? h.rate;

  return (
    <section className="heloc" id="heloc">
      <div className="hhead">
        <div><div className="eyebrow">Home equity line of credit</div><h2>HELOC</h2></div>
        <div className="hsub">{`${fmt(h.limit)} line · ${shownRate}% APR · opened ${shortLabel(h.start)} · ${h.drawYears}-yr draw to ${shortLabel(addMonths(c.endKey, -1))} · ${h.repayYears}-yr repayment to ${shortLabel(addMonths(c.repayEndKey, -1))}`}</div>
      </div>
      <div className="hgrid">
        <div className="hcard">
          <h3>From your statement</h3>
          <div className="fields">
            <HField k="balance" label="Loan balance" cls="key" v={h.balance} onCommit={upd} />
            <HField k="available" label="Available credit" cls="key" v={h.available} onCommit={upd} />
            <HField k="ytdInterest" label="Interest paid YTD" cls="key" v={h.ytdInterest} onCommit={upd} />
            <HField k="rate" label="Current rate (APR %)" cls="key" v={shownRate} plain onCommit={upd} />
          </div>
          <div className="hnote" style={{ marginTop: 10 }}>Checking your HELOC bill as paid updates these automatically, so enter the balance from <em>before</em> this month’s payment.</div>
          <div className="hdiv" />
          <div className="settings-label">Line terms</div>
          <div className="fields">
            <HField k="limit" label="Credit limit" v={h.limit} onCommit={upd} />
            <div className="field"><label htmlFor="h-start">Opened</label><input type="month" id="h-start" value={h.start} onChange={e => e.target.value && upd('start', e.target.value)} /></div>
            <HField k="drawYears" label="Draw period (years)" v={h.drawYears} plain onCommit={upd} />
            <HField k="repayYears" label="Repayment period (years)" v={h.repayYears} plain onCommit={upd} />
          </div>
          {Math.abs(diff) >= 1 && <div className="hwarn">Balance + available credit is {fmt(Math.abs(diff))} {diff > 0 ? 'more' : 'less'} than the credit limit. Pending transactions or holds can cause this.</div>}
        </div>
        <ThisMonth month={shown} mkey={mkey} c={c} year={year} />
        <Shortfalls month={month} c={c} mkey={mkey} />
      </div>
      <div className="ratebar">
        <span className="settings-label">Interest rate</span>
        <input type="range" min={0} max={20} step={0.05} value={shownRate} aria-label="Interest rate" onChange={e => setRateLive(e.target.value)} />
        <span className="ratev"><Field inputMode="decimal" aria-label="Interest rate percent" value={shownRate} onCommit={v => setRateLive(v)} />%</span>
        <span className="hnote">Drag or type to change the rate. This month’s payment and every payoff projection update.</span>
      </div>
      {c.B > 0 ? (
        <>
          <div className="opts" id="hOptsWrap">
            <div id="hOpts" style={{ display: 'contents' }}>
              {c.opts.map(o => {
                const minI = c.opts[0].interest, base = c.opts[0].pmt;
                const sub = o.key === 'min' ? (o.pmt2 != null ? `Interest only until ${shortLabel(addMonths(c.endKey, -1))}, then ${h.repayYears} years of principal + interest` : 'Required repayment-period payment') : `${o.n} equal monthly payments`;
                return (
                  <div key={o.key} className={`hcard opt ${o.key}`} style={{ ['--c' as string]: OPT_COLORS[o.key] }}>
                    <div className="optname"><span className="dot" />{o.name}</div><div className="optsub">{sub}</div>
                    <div className="pmt num">{fmt(o.pmt)}<small>/mo</small></div>
                    {o.key === 'min' ? <>
                      {o.pmt2 != null && <div className="kv"><span>From {shortLabel(c.endKey)}</span><b className="num">{fmt(o.pmt2)}/mo</b></div>}
                      <div className="kv"><span>Paid off</span><b>{shortLabel(o.payoff)}</b></div>
                      <div className="kv"><span>Total interest</span><b className="num">{fmt(o.interest)}</b></div>
                    </> : <>
                      <div className="kv"><span>Paid off</span><b>{shortLabel(o.payoff)}</b></div>
                      <div className="kv"><span>Total interest</span><b className="num">{fmt(o.interest)}</b></div>
                      <div className="kv"><span>Extra vs. minimum</span><b className="num">+{fmt(r2(o.pmt - base))}/mo</b></div>
                      <div className="kv"><span>Interest saved</span><b className="num pos">{fmt(r2(minI - o.interest))}</b></div>
                    </>}
                    <div className="grow" /><button className="mini" onClick={() => setHelocBill(o.pmt)}>Use as HELOC bill</button>
                  </div>
                );
              })}
            </div>
            <CustomHeloc c={c} customPmt={h.customPmt || 0} onCommit={v => upd('customPmt', v)} />
          </div>
          <div className="hcard chartcard">
            <div className="charthead"><h3>Balance over time</h3><span className="hnote">Assumes the rate stays the same and no new draws</span></div>
            <HelocChart c={c} mkey={mkey} />
          </div>
        </>
      ) : <div className="hcard chartcard"><div className="hempty">Enter your loan balance to see repayment options.</div></div>}
    </section>
  );
}

function setHelocBill(amount: number) {
  run(() => dispatch({ type: 'heloc.setBill', amount, billId: uid() }));
}

function HField({ k, label, cls = '', v, plain = false, onCommit }: { k: string; label: string; cls?: string; v: number; plain?: boolean; onCommit: (k: string, v: unknown) => void }) {
  return (
    <div className={`field ${cls}`}><label htmlFor={`h-${k}`}>{label}</label>
      <div className={`inwrap ${plain ? '' : 'money'}`}>
        <Field id={`h-${k}`} inputMode="decimal" value={v} format={plain ? (x => String(x ?? '')) : money2} onCommit={t => onCommit(k, t)} />
      </div>
    </div>
  );
}

function ThisMonth({ month, mkey, c, year }: { month: Month; mkey: string; c: HelocCalc; year: string }) {
  const h = month.heloc;
  const hb = month.bills.find(b => /heloc/i.test(b.name));
  const util = h.limit > 0 ? Math.min(100, c.B / h.limit * 100) : 0;
  const monthsLeftInYear = 12 - (mIdx(mkey) % 12);
  const projYear = r2((Number(h.ytdInterest) || 0) + c.io * monthsLeftInYear);
  return (
    <div className="hcard" id="hStats">
      <h3>{monthLabel(mkey)} payment</h3>
      <div className="big num" data-testid="heloc-this-month">{fmt(c.thisMonth)}</div>
      <div className="hnote">{c.mLeft
        ? `Interest-only minimum during the draw period: balance × ${h.rate}% × ${c.days} days ÷ 365. Ranges ${fmt(c.lo)}–${fmt(c.hi)} depending on month length.`
        : `Repayment period: principal + interest to pay off the balance over the ${c.repayLeft} months left.`}</div>
      {hb && c.applied ? (
        <div className="billlink" style={{ display: 'block' }}><span className="pos">✓ “{hb.name}” paid {fmt(hb.amount)}</span><br />
          <span className="hnote">{fmt(c.applied.interest)} to interest (added to YTD) and {fmt(c.applied.principal)} to principal (balance and available credit updated).</span></div>
      ) : hb ? (
        Math.abs((Number(hb.amount) || 0) - c.thisMonth) < 0.005
          ? <div className="billlink">✓ Your “{hb.name}” bill matches this estimate.</div>
          : <div className="billlink">Your “{hb.name}” bill is <b className="num">{fmt(hb.amount)}</b> <button className="mini" onClick={() => setHelocBill(c.thisMonth)}>Set to {fmt(c.thisMonth)}</button></div>
      ) : <div className="billlink">No HELOC bill this month. <button className="mini" onClick={() => setHelocBill(c.thisMonth)}>Add one for {fmt(c.thisMonth)}</button></div>}
      <div className="hdiv" />
      <div className="kv"><span>Used</span><b className="num">{fmt(c.B)} of {fmt(h.limit)}</b></div>
      <div className="bar hbar"><i style={{ width: util + '%' }} /></div>
      <div className="kv"><span>Available to draw</span><b className="num">{fmt(h.available)}</b></div>
      <div className="kv"><span>Draw period left</span><b>{c.mLeft ? `${Math.floor(c.mLeft / 12)} yr ${c.mLeft % 12} mo` : 'Ended'}</b></div>
      <div className="kv"><span>Repayment period</span><b>{shortLabel(c.endKey)} – {shortLabel(addMonths(c.repayEndKey, -1))}</b></div>
      {c.mLeft > 0 && <><div className="kv"><span>Payment when repayment starts</span><b className="num">{fmt(c.repayPmt)}</b></div>
        <div className="hnote" style={{ textAlign: 'right', marginTop: -2 }}>if the balance and rate stay the same</div></>}
      <div className="kv"><span>Interest paid {year} so far</span><b className="num">{fmt(h.ytdInterest)}</b></div>
      <div className="kv"><span>Projected {year} total</span><b className="num">{fmt(projYear)}</b></div>
    </div>
  );
}

function Shortfalls({ month, c, mkey }: { month: Month; c: HelocCalc; mkey: string }) {
  const h = month.heloc;
  const short = shortfalls(month);
  const totalNeed = r2(short.reduce((t, x) => t + x.need, 0));
  const avail = Number(h.available) || 0;
  const un = billsFor(month, null);
  const [amt, setAmt] = useState('');
  const [acct, setAcct] = useState(month.accounts[0]?.id || '');
  const acctName = (id: string) => month.accounts.find(a => a.id === id)?.name || 'removed account';
  return (
    <div className="hcard" id="hShort">
      <h3>Cover shortfalls</h3>
      {!short.length ? <div className="ok">✓ Every account covers its bills this month.</div> : <>
        <div className="hnote">Even after expected deposits, these accounts can’t cover their unpaid bills. Transfer from an account with money to spare, or draw on the HELOC (that adds to the loan balance).</div>
        <div className="shortlist">{short.map(x => (
          <div className="srow" key={x.account.id}><span className="dot" style={{ background: x.account.color }} /><span className="sn">{x.account.name}</span>
            <span className="neg num">−{fmt(x.need)}</span>
            <button className="mini" onClick={() => coverWithTransfer(month, x.account.id, x.need)} title="Move money from an account with some to spare">Transfer</button>
            <button className="mini" disabled={x.need > avail} onClick={() => run(() => dispatch({ type: 'heloc.cover', acctId: x.account.id, ids: [uid()] }))}>Draw</button></div>
        ))}</div>
        <div className="kv tot"><span>Total shortfall</span><b className="neg num">{fmt(totalNeed)}</b></div>
        <div className="kv"><span>Payment after covering</span><b className="num">{fmt(r2((c.B + totalNeed) * c.rate * c.days / 365))}</b></div>
        <button className="pbtn wide" disabled={totalNeed > avail} onClick={() => run(() => dispatch({ type: 'heloc.cover', ids: short.map(() => uid()) }))}>Cover all · {fmt(totalNeed)}</button>
        {totalNeed > avail && <div className="hwarn">Not enough available credit to cover all of it.</div>}
      </>}
      {un.length > 0 && <div className="hnote" style={{ marginTop: 10 }}>{un.length} unassigned bill{un.length > 1 ? 's' : ''} ({fmt(sum(un))}) aren’t counted here yet.</div>}
      <div className="hdiv" /><div className="settings-label">Manual draw</div>
      <form className="drawrow" onSubmit={e => {
        e.preventDefault();
        const a = Math.abs(cents(amt));
        if (!(a > 0) || !acct) return;
        try { dispatch({ type: 'heloc.draw', id: uid(), acctId: acct, amount: a }); setAmt(''); } catch (err) { toast((err as Error).message, true); }
      }}>
        <div className="inwrap money"><input type="text" inputMode="decimal" placeholder="0.00" aria-label="Draw amount" value={amt} onChange={e => setAmt(e.target.value)} /></div>
        <select aria-label="Draw into account" value={acct} onChange={e => setAcct(e.target.value)}>{month.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <button className="mini">Draw</button>
      </form>
      {h.draws.length > 0 && <div className="drawlog">{h.draws.map(d => (
        <div className="drow" key={d.id}><span className="num">{fmt(d.amount)} → {acctName(d.acctId)}</span>
          <button className="link" onClick={() => run(() => dispatch({ type: 'heloc.undoDraw', id: d.id }))}>Undo</button></div>
      ))}</div>}
      {mkey && null}
    </div>
  );
}

function CustomHeloc({ c, customPmt, onCommit }: { c: HelocCalc; customPmt: number; onCommit: (v: string) => void }) {
  const cu = c.custom, warn = customWarning(c);
  return (
    <div className="hcard opt custom" style={{ ['--c' as string]: OPT_COLORS.custom }}>
      <div className="optname"><span className="dot" />Your payment</div><div className="optsub">Type any monthly amount</div>
      <div className="pmtin num"><span>$</span><Field inputMode="decimal" placeholder="0.00" aria-label="Your HELOC payment" value={customPmt} format={moneyOrBlank} onCommit={onCommit} /><small>/mo</small></div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        {!(cu.pmt > 0) ? <div className="hnote">Enter a monthly amount to see when the line would be paid off. The minimum right now is {fmt(c.io)}.</div>
          : cu.never ? <div className="hwarn" style={{ marginTop: 0 }}>That doesn’t cover the monthly interest (about {fmt(c.io)}), so the balance would never go down.</div>
          : <>
            <div className="kv"><span>Paid off</span><b>{shortLabel(cu.payoff!)}</b></div>
            <div className="kv"><span>Takes</span><b>{Math.floor(cu.n! / 12) ? Math.floor(cu.n! / 12) + ' yr ' : ''}{cu.n! % 12} mo</b></div>
            <div className="kv"><span>Total interest</span><b className="num">{fmt(cu.interest)}</b></div>
            <div className="kv"><span>{cu.pmt >= c.opts[0].pmt ? 'Extra vs. minimum' : 'Less than minimum'}</span><b className="num">{cu.pmt >= c.opts[0].pmt ? '+' : '−'}{fmt(Math.abs(r2(cu.pmt - c.opts[0].pmt)))}/mo</b></div>
            <Saved v={r2(c.opts[0].interest - (cu.interest || 0))} />
            {warn?.kind === 'below-min' && <div className="hwarn">Below the required minimum of {fmt(warn.min)}.</div>}
            {warn?.kind === 'repay-jump' && <div className="hwarn">When repayment starts in {shortLabel(warn.at)} you’d still owe {fmt(warn.owed)}, and the required payment would rise to about {fmt(warn.need)}/mo.</div>}
            <div className="grow" /><button className="mini" onClick={() => setHelocBill(cu.pmt)}>Use as HELOC bill</button>
          </>}
      </div>
    </div>
  );
}

const Saved = ({ v }: { v: number }) => v >= 0
  ? <div className="kv"><span>Interest saved</span><b className="num pos">{fmt(v)}</b></div>
  : <div className="kv"><span>Extra interest vs. minimum</span><b className="num neg">{fmt(-v)}</b></div>;

function HelocChart({ c, mkey }: { c: HelocCalc; mkey: string }) {
  const W = 1200, Ht = 300, L = 58, R = 18, T = 16, Bm = 28;
  const lines: Array<{ key: string; name: string; pmt: number; n: number; at: (k: number) => number }> =
    [...c.opts, ...(c.custom.at ? [{ key: 'custom', name: c.custom.name, pmt: c.custom.pmt, n: c.custom.n!, at: c.custom.at }] : [])];
  const n = Math.min(360, Math.max(c.opts[0].n, 60, c.custom.n || 0, 1));
  const x = (k: number) => L + (W - L - R) * k / n;
  const y = (v: number) => T + (Ht - T - Bm) * (1 - v / c.B);
  const s = mIdx(mkey);
  const years: number[] = [];
  for (let k = 0; k <= n; k++) if ((s + k) % 12 === 0) years.push(k);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${Ht}`} className="chart" role="img" aria-label="HELOC balance over time">
        {[0, 0.5, 1].map(f => <g key={f}><line x1={L} x2={W - R} y1={y(c.B * f)} y2={y(c.B * f)} className="grid" /><text x={L - 8} y={y(c.B * f) + 4} textAnchor="end" className="ax">{k$(c.B * f)}</text></g>)}
        {years.map(k => <text key={k} x={x(k)} y={Ht - 8} textAnchor="middle" className="ax">{Math.floor((s + k) / 12)}</text>)}
        {c.mLeft > 0 && <><line x1={x(c.mLeft)} x2={x(c.mLeft)} y1={T} y2={Ht - Bm} className="endline" /><text x={x(c.mLeft) + 6} y={T + 10} className="ax">Repayment period begins</text></>}
        {c.repayLeft > 0 && c.repayLeft <= n && <><line x1={x(c.repayLeft)} x2={x(c.repayLeft)} y1={T} y2={Ht - Bm} className="endline" /><text x={x(c.repayLeft) - 6} y={T + 10} textAnchor="end" className="ax">Line ends</text></>}
        {lines.map(o => {
          const last = Math.min(o.n, n), pts: string[] = [];
          for (let k = 0; k <= last; k++) pts.push(`${x(k).toFixed(1)},${y(Math.max(0, o.at(k))).toFixed(1)}`);
          return pts.length > 1 ? <polyline key={o.key} points={pts.join(' ')} fill="none" style={{ stroke: OPT_COLORS[o.key] }} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={o.key === 'min' ? '6 5' : undefined} /> : null;
        })}
      </svg>
      <div className="legend">{lines.map(o => <span key={o.key}><i style={{ ['--c' as string]: OPT_COLORS[o.key] }} />{o.name} · {fmt(o.pmt)}/mo</span>)}</div>
    </>
  );
}

/* ---------------- car loans and mortgage ---------------- */
type FType = 'money' | 'plain' | 'text' | 'month';

function LoanCard({ loan: l, month, mkey }: { loan: Loan; month: Month; mkey: string }) {
  const c = loanCalc(month, l, mkey), cur = c.opts[0];
  const upd = (k: string, v: unknown) => run(() => dispatch({ type: 'loan.update', id: l.id, version: l.version, patch: { [k]: v } }));
  const names = [...new Set(month.bills.map(b => b.name))];
  const v0 = c.valAt ? c.valAt(0) : null;
  const eq = c.equity;
  // A render helper, not a component, so fields keep focus when the month refreshes.
  const lf = (k: keyof Loan, label: string, type: FType) => {
    const v = l[k];
    if (type === 'month') return <div className="field"><label>{label}</label><input type="month" aria-label={label} value={String(v || '')} onChange={e => upd(k, e.target.value)} /></div>;
    const fmtv = type === 'money' ? moneyOrBlank : type === 'plain' ? ((x: unknown) => (x || x === 0 ? (!x ? '' : String(x)) : '')) : ((x: unknown) => String(x ?? ''));
    return (
      <div className={`field ${type === 'text' && k !== 'lender' ? 'wide' : ''}`}><label>{label}</label>
        <div className={`inwrap ${type === 'money' ? 'money' : ''}`}>
          <Field aria-label={`${l.name} ${label}`} inputMode={type === 'text' ? undefined : 'decimal'} spellCheck={type === 'text' ? false : undefined}
            placeholder={type === 'money' ? '0.00' : ''} value={v} format={fmtv} onCommit={t => upd(k, t)} />
        </div></div>
    );
  };
  return (
    <div className="hcard loan" data-loan={l.id}>
      <div className="loanhead">
        <Field className="loanname" aria-label="Loan name" value={l.name} onCommit={t => upd('name', t)} />
        <span className="hsub">{[l.lender, l.rate ? `${l.rate}% APR` : '', l.kind === 'home' && c.escw ? `${fmt(c.pi)} principal & interest + ${fmt(c.escw)} escrow` : ''].filter(Boolean).join(' · ')}</span>
        <button className="x" title="Remove loan" aria-label={`Remove ${l.name}`} onClick={async () => {
          if (await ask(`Remove “${l.name}” from ${monthLabel(mkey)}?`, 'Remove')) run(() => dispatch({ type: 'loan.remove', id: l.id, version: l.version }));
        }}>×</button>
      </div>
      <div className="lgrid">
        <div>
          <div className="settings-label">From your statement</div>
          <div className="fields">
            {lf('balance', 'Principal balance', 'money')}
            {lf('rate', 'Rate (APR %)', 'plain')}
            {lf('payment', 'Monthly payment', 'money')}
            {l.kind === 'home' ? lf('escrow', 'Escrow part', 'money') : lf('lender', 'Lender', 'text')}
          </div>
          <div className="hdiv" /><div className="settings-label">Loan contract</div>
          <div className="fields">
            {lf('original', 'Original amount', 'money')}
            {lf('open', 'Opened', 'month')}
            {lf('term', 'Term (months)', 'plain')}
            <div className="field"><label>Type</label>
              <select className="lsel" aria-label={`${l.name} type`} value={l.kind} onChange={e => upd('kind', e.target.value)}>
                <option value="car">Car</option><option value="home">Home</option><option value="other">Other</option></select></div>
          </div>
          {l.kind !== 'other' && <>
            <div className="hdiv" /><div className="settings-label">{l.kind === 'car' ? 'Vehicle' : 'Home'} value</div>
            <div className="fields">
              {l.kind === 'car' && <>{lf('vin', 'VIN', 'text')}{lf('purchasePrice', 'Purchase price', 'money')}</>}
              {lf('value', l.kind === 'car' ? 'Current value' : 'Home value', 'money')}
              {lf('valueRate', 'Value change %/yr', 'plain')}
            </div>
            <div className="hnote" style={{ marginTop: 8 }}>{l.valueEstimated
              ? 'Starting value is an estimate from current market data. Replace it with a Kelley Blue Book or Edmunds value for your exact trim and mileage.'
              : (Number(l.value) ? `Value entered ${shortLabel(l.valueAsOf)}, projected at ${l.valueRate > 0 ? '+' : ''}${l.valueRate}% a year.` : '')}</div>
          </>}
          <div className="hdiv" />
          <div className="field"><label>Paid by bill</label>
            <select className="lsel" aria-label={`${l.name} paid by bill`} value={l.billName} onChange={e => upd('billName', e.target.value)}>
              <option value="">(not linked)</option>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
              {l.billName && !names.includes(l.billName) && <option value={l.billName}>{l.billName}</option>}
            </select></div>
        </div>
        <div className="lmain">
          <div className="lstats">
            <div className="lstat"><div className="k">Balance</div><div className="v num" data-testid={`loan-balance-${l.id}`}>{fmt(c.B)}</div></div>
            <div className="lstat"><div className="k">Paid off</div><div className="v">{cur.never ? '—' : cur.payoff ? shortLabel(cur.payoff) : 'Done'}</div><div className="sub">{cur.n ? `${cur.n} payments left` : ''}</div></div>
            <div className="lstat"><div className="k">Interest left</div><div className="v num">{cur.never ? '—' : fmt(cur.interest)}</div></div>
            <div className="lstat"><div className="k">Equity</div><div className={`v num ${eq == null ? '' : eq < 0 ? 'neg' : 'pos'}`}>{eq == null ? '—' : fmt(eq)}</div>
              <div className="sub">{eq == null ? (l.kind === 'other' ? '' : 'Enter a value') : l.kind === 'home' ? `${Math.round(c.B / (v0 || 1) * 100)}% loan-to-value` : `worth about ${fmt(v0)}`}</div></div>
          </div>
          <LoanNotes l={l} c={c} />
          <div className="lopts">
            <div style={{ display: 'contents' }}>
              {c.opts.map(o => (
                <div key={o.key} className="lopt" style={{ ['--c' as string]: LOAN_COLORS[o.key] }}>
                  <div className="optname"><span className="dot" />{o.name}</div><div className="pmt num">{fmt(r2(o.P + c.escw))}<small>/mo</small></div>
                  <OptBody o={o} base={cur} />
                </div>
              ))}
            </div>
            <div className="lopt custom" style={{ ['--c' as string]: LOAN_COLORS.custom }}>
              <div className="optname"><span className="dot" />Your payment</div>
              <div className="pmtin num"><span>$</span><Field inputMode="decimal" placeholder="0.00" aria-label={`${l.name} your payment`} value={l.customPmt} format={moneyOrBlank} onCommit={t => upd('customPmt', t)} /><small>/mo</small></div>
              {c.custom ? <OptBody o={c.custom} base={cur} /> : <div className="hnote">Type a monthly amount{l.kind === 'home' ? ', including escrow' : ''}.</div>}
            </div>
          </div>
          {c.B > 0 && <LoanChart c={c} mkey={mkey} />}
        </div>
      </div>
    </div>
  );
}

function LoanNotes({ l, c }: { l: Loan; c: LoanCalc }) {
  const cur = c.opts[0], notes: ReactElement[] = [];
  if (c.applied && c.bill) notes.push(<div key="a" className="pos">✓ “{c.bill.name}” paid this month: {fmt(c.applied.interest)} interest, {fmt(c.applied.principal)} principal{c.applied.escrow ? `, ${fmt(c.applied.escrow)} escrow` : ''}. Balance updated.</div>);
  else if (c.bill && Math.abs((Number(c.bill.amount) || 0) - (Number(l.payment) || 0)) >= 0.005)
    notes.push(<div key="b">Your “{c.bill.name}” bill is {fmt(c.bill.amount)}. <button className="mini" onClick={() => run(() => dispatch({ type: 'loan.matchBill', id: l.id }))}>Set it to {fmt(l.payment)}</button></div>);
  else if (!c.bill) notes.push(<div key="c" className="hnote">Link a bill below so checking it paid lowers this balance.</div>);
  if (cur.never && c.B > 0) notes.push(<div key="d" className="hwarn">The payment doesn’t cover the monthly interest, so the balance won’t go down.</div>);
  if (c.sched && !cur.never && cur.n) {
    const diff = cur.n - c.sched.left;
    if (diff > 3) notes.push(<div key="e" className="hwarn">At {fmt(l.payment)}/mo this balance needs {cur.n} more payments, but a {l.term}-month loan opened {shortLabel(l.open)} should have about {c.sched.left} left (last payment {shortLabel(c.sched.last)}). The term may be longer, or the balance, rate or payment may be different. Worth checking the contract.</div>);
    else notes.push(<div key="f" className="hnote">Contract: {l.term} months{c.sched.pmt ? ` at ${fmt(c.sched.pmt)}/mo` : ''}, first payment {shortLabel(c.sched.first)}, last {shortLabel(c.sched.last)}. {c.sched.made} of {l.term} payments made{Number(l.original) ? `, ${fmt(r2(l.original - c.B))} of principal paid off` : ''}. {diff > 0 ? `About ${diff} payment${diff > 1 ? 's' : ''} behind that schedule.` : diff < 0 ? `About ${-diff} payment${diff < -1 ? 's' : ''} ahead of schedule.` : 'On schedule.'}</div>);
  }
  if (c.equity != null && c.equity < 0 && !cur.never && cur.at)
    notes.push(<div key="g" className="hnote">You owe about {fmt(-c.equity)} more than it’s worth.{c.flipsPositive ? ` At the current payment that flips to positive equity around ${shortLabel(c.flipsPositive)}.` : ''}</div>);
  return <div className="lnotes">{notes}</div>;
}

function OptBody({ o, base }: { o: LoanPlan; base: LoanPlan }) {
  if (o.never) return <div className="hwarn" style={{ marginTop: 0 }}>Doesn’t cover the monthly interest.</div>;
  let extra: ReactElement | null = null;
  if (o.key !== 'cur' && !base.never) {
    const saved = r2((base.interest || 0) - (o.interest || 0)), sooner = (base.n || 0) - (o.n || 0);
    extra = saved >= 0
      ? <><div className="kv"><span>Saves</span><b className="num pos">{fmt(saved)}</b></div><div className="kv"><span>Done sooner</span><b>{sooner} mo</b></div></>
      : <><div className="kv"><span>Extra interest</span><b className="num neg">{fmt(-saved)}</b></div><div className="kv"><span>Takes longer</span><b>{-sooner} mo</b></div></>;
  }
  return <><div className="kv"><span>Paid off</span><b>{o.payoff ? shortLabel(o.payoff) : '—'}</b></div>
    <div className="kv"><span>Interest left</span><b className="num">{fmt(o.interest)}</b></div>{extra}</>;
}

function LoanChart({ c, mkey }: { c: LoanCalc; mkey: string }) {
  const series = c.opts.concat(c.custom ? [c.custom] : []).filter(o => !o.never && o.at);
  if (!series.length) return null;
  const n = Math.min(480, Math.max(12, ...series.map(o => o.n || 0)));
  let ymax = c.B;
  if (c.valAt) for (let k = 0; k <= n; k++) ymax = Math.max(ymax, c.valAt(k));
  const W = 820, Ht = 230, Lp = 56, R = 14, T = 14, Bm = 26;
  const x = (k: number) => Lp + (W - Lp - R) * k / n, y = (v: number) => T + (Ht - T - Bm) * (1 - v / ymax);
  const step = n > 240 ? 5 : n > 120 ? 2 : 1, s0 = mIdx(mkey);
  const yrs: number[] = [];
  for (let k = 0; k <= n; k++) { const mi = s0 + k; if (mi % 12 === 0 && Math.floor(mi / 12) % step === 0) yrs.push(k); }
  const line = (fn: (k: number) => number, last: number, color: string, dash?: boolean, key?: string) => {
    const pts: string[] = [];
    for (let k = 0; k <= last; k++) pts.push(`${x(k).toFixed(1)},${y(fn(k)).toFixed(1)}`);
    return <polyline key={key} points={pts.join(' ')} fill="none" style={{ stroke: color }} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dash ? '7 5' : undefined} />;
  };
  return (
    <>
      <svg viewBox={`0 0 ${W} ${Ht}`} className="chart" role="img" aria-label="Loan balance over time">
        {[0, 0.5, 1].map(f => <g key={f}><line x1={Lp} x2={W - R} y1={y(ymax * f)} y2={y(ymax * f)} className="grid" /><text x={Lp - 8} y={y(ymax * f) + 4} textAnchor="end" className="ax">{k$(ymax * f)}</text></g>)}
        {yrs.map(k => <text key={k} x={x(k)} y={Ht - 8} textAnchor="middle" className="ax">{Math.floor((s0 + k) / 12)}</text>)}
        {c.valAt && line(c.valAt, n, LOAN_COLORS.value, true, 'value')}
        {series.map(o => line(o.at!, Math.min(o.n || 0, n), LOAN_COLORS[o.key], false, o.key))}
      </svg>
      <div className="legend">
        {c.valAt && <span><i style={{ ['--c' as string]: LOAN_COLORS.value }} />Estimated value</span>}
        {series.map(o => <span key={o.key}><i style={{ ['--c' as string]: LOAN_COLORS[o.key] }} />{o.name} · {fmt(r2(o.P + c.escw))}/mo</span>)}
      </div>
    </>
  );
}
