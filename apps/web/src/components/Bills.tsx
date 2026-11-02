import { useState, type FormEvent } from 'react';
import { acctStats, billsFor, cents, fmt, leftAfterMove, monthLabel, ordinal, r2, sum, uid, type Account, type Bill, type Month } from '@optimystic/core';
import { dispatch, getState, toast, useDerived, useStore } from '../store';
import { ask, Field, Modal, money2, usePhone, useTouch } from '../ui';
import { coverWithTransfer, TransfersPanel } from './Transfers';

const run = (f: () => void) => { try { f(); } catch (e) { toast((e as Error).message, true); } };

export function BillsTab() {
  const d = useDerived()!;
  const t = d.totals;
  return (
    <>
      <section className="summary">
        <div className="stat hero"><div className="k">Left over</div><div className={`v num ${t.left < 0 ? 'neg' : 'pos'}`} data-testid="left-over">{fmt(t.left)}</div><div className="sub">balances + deposits − all bills</div></div>
        <div className="stat"><div className="k">Cash on hand</div><div className="v num">{fmt(t.cash)}</div></div>
        <div className="stat"><div className="k">Deposits coming</div><div className="v num pos">{fmt(t.deposits)}</div></div>
        <div className="stat"><div className="k">Monthly bills</div><div className="v num">{fmt(t.bills)}</div></div>
        <div className="stat"><div className="k">Paid</div><div className="v num">{fmt(t.paid)}</div></div>
        <div className="stat"><div className="k">Still due</div><div className="v num">{fmt(t.due)}</div></div>
        <div className="stat"><div className="k">Unassigned</div><div className={`v num ${t.unassignedCount ? 'neg' : ''}`}>{t.unassignedCount ? fmt(t.unassigned) : '—'}</div></div>
        <div className="stat"><div className="k">Card bills next month</div><div className="v num">{fmt(d.budget.projected)}</div><div className="sub">from the card budget</div></div>
      </section>
      <p className="hint">Put each bill on the account it’s paid from{useTouch() ? ' (tap Move to…)' : ' by dragging it'}. Enter each account’s starting balance and the deposits still expected this month; every bill and transfer on an account counts against it. Ticking a bill paid is just a marker, except for the car, mortgage and HELOC bills, where it applies the payment to that loan.</p>
      <TransfersPanel month={useStore(s => s.month)!} />
      <Board />
    </>
  );
}

function Board() {
  const month = useStore(s => s.month)!;
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const dnd = { drag, setDrag, over, setOver };
  return (
    <main id="board">
      <Column month={month} account={null} dnd={dnd} />
      <div className="accounts">
        {month.accounts.map(a => <Column key={a.id} month={month} account={a} dnd={dnd} />)}
        <button type="button" className="col addcol" onClick={() => setAdding(true)}><span className="plus">+</span><span>Add account</span></button>
      </div>
      {adding && <AccountDialog onClose={() => setAdding(false)} />}
    </main>
  );
}

interface Dnd { drag: string | null; setDrag: (v: string | null) => void; over: string | null | undefined; setOver: (v: string | null | undefined) => void }

function move(month: Month, billId: string, to: string | null) {
  const b = month.bills.find(x => x.id === billId);
  if (!b || (b.accountId || null) === to) return;
  run(() => dispatch({ type: 'bill.update', id: b.id, version: b.version, patch: { accountId: to } }));
}

function Column({ month, account: a, dnd }: { month: Month; account: Account | null; dnd: Dnd }) {
  const id = a ? a.id : null;
  const list = billsFor(month, id);
  const isOver = dnd.drag !== null && dnd.over === id;
  const preview = isOver && a && dnd.drag ? leftAfterMove(month, dnd.drag, a.id) : null;
  const s = a ? acctStats(month, a) : null;
  const bal = a ? r2((Number(a.balance) || 0) + (s?.dep || 0)) : 0;
  const pct = s ? (bal > 0 ? Math.min(100, s.total / bal * 100) : (s.total > 0 ? 100 : 0)) : 0;
  return (
    <section
      className={`col ${a ? 'acct' : 'pool'} ${isOver ? 'over' : ''}`}
      style={a ? { ['--c' as string]: a.color } : undefined}
      data-account={id ?? 'unassigned'}
      onDragOver={e => { if (!dnd.drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dnd.over !== id) dnd.setOver(id); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) dnd.setOver(undefined); }}
      onDrop={e => { e.preventDefault(); const bid = dnd.drag || e.dataTransfer.getData('text/plain'); dnd.setDrag(null); dnd.setOver(undefined); if (bid) move(month, bid, id); }}
    >
      {a && s ? (
        <>
          <div className="acchead">
            <span className="dot" />
            <Field className="acctname" aria-label="Account name" value={a.name} onCommit={v => run(() => dispatch({ type: 'account.update', id: a.id, version: a.version, patch: { name: v } }))} />
            <button type="button" className="x" title="Remove account" aria-label={`Remove ${a.name}`} onClick={async () => {
              const n = list.length;
              if (await ask(`Remove “${a.name}” from ${monthLabel(getState().key)}?${n ? `\n\nIts ${n} bill(s) will move back to Unassigned.` : ''}`, 'Remove'))
                run(() => dispatch({ type: 'account.remove', id: a.id, version: a.version }));
            }}>×</button>
          </div>
          <div className="balrow"><span className="k">Starting balance</span>
            <label className="balinput num"><span>$</span>
              <Field inputMode="decimal" aria-label={`${a.name} starting balance`} value={a.balance} format={money2}
                onCommit={v => run(() => dispatch({ type: 'account.update', id: a.id, version: a.version, patch: { balance: cents(v) } }))} /></label>
          </div>
          <label className="deprow"><span className="k">Monthly deposits</span>
            <span className="depin"><span>+$</span>
              <Field inputMode="decimal" aria-label={`${a.name} monthly deposits`} title="Paychecks or transfers expected into this account this month" value={a.deposit || 0} format={money2}
                onCommit={v => run(() => dispatch({ type: 'account.update', id: a.id, version: a.version, patch: { deposit: v } }))} /></span>
          </label>
          <div className={`bar ${s.left < 0 ? 'over' : ''}`} title={bal > 0 ? `${Math.round(s.total / bal * 100)}% of balance + deposits spoken for` : ''}><i style={{ width: pct + '%' }} /></div>
          <div className="nums num">
            <span className="lbl">Bills from here</span><span>{fmt(s.total)}</span>
            <span className="lbl">Marked paid</span><span>{fmt(s.paid)}</span>
            <span className="lbl">Not marked paid</span><span>{fmt(s.due)}</span>
            {s.xferIn > 0 && <><span className="lbl">Transfers in</span><span className="pos" data-testid={`xin-${a.id}`}>+{fmt(s.xferIn)}</span></>}
            {s.xferOut > 0 && <><span className="lbl">Transfers out</span><span data-testid={`xout-${a.id}`}>−{fmt(s.xferOut)}</span></>}
            <span className="leftlbl">Left after bills</span><span className={`left ${s.left < 0 ? 'neg' : 'pos'}`} data-testid={`left-${a.id}`}>{fmt(s.left)}</span>
          </div>
          {s.left < 0 && month.accounts.length > 1 && (
            <button type="button" className="linkbtn covertx" onClick={() => coverWithTransfer(month, a.id, r2(-s.left))}>Cover {fmt(-s.left)} with a transfer</button>
          )}
          <div className="preview">{preview !== null ? `After drop: ${fmt(preview)} left` : ''}</div>
        </>
      ) : (
        <div className="poolhead"><h2>Unassigned</h2><span className="count num">{list.length ? `${list.length} · ${fmt(sum(list))}` : ''}</span></div>
      )}
      <div className="zone">
        {list.length ? list.map(b => <BillCard key={b.id} bill={b} month={month} dnd={dnd} />)
          : <div className="empty">{a ? 'Drop bills here' : 'Every bill has a home'}</div>}
      </div>
    </section>
  );
}

function BillCard({ bill: b, month, dnd }: { bill: Bill; month: Month; dnd: Dnd }) {
  const touch = useTouch(), phone = usePhone();
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  return (
    <div className={`card ${b.paid ? 'paid' : ''} ${b.recurring ? '' : 'expense'} ${dnd.drag === b.id ? 'dragging' : ''}`} data-bill={b.name}
      draggable={!touch}
      onDragStart={e => { dnd.setDrag(b.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id); }}
      onDragEnd={() => { dnd.setDrag(null); dnd.setOver(undefined); }}>
      <div className="r1">
        <input type="checkbox" className="chk" checked={!!b.paid} title="Mark paid" aria-label={`Mark ${b.name} paid`}
          onChange={e => run(() => dispatch({ type: 'bill.update', id: b.id, version: b.version, patch: { paid: e.target.checked } }))} />
        <span className="nm">{b.name}</span><span className="amt">{fmt(b.amount)}</span>
      </div>
      <div className="r2">
        <span className="meta">
          {!Number(b.amount) && <span className="zero">Set amount</span>}
          {b.dueDay ? <span>Due the {ordinal(b.dueDay)}</span> : null}
          {b.recurring ? <span>Monthly bill</span> : <span className="exp">Expense</span>}
        </span>
        <span className="ctl">
          {phone || touch
            ? <button type="button" onClick={() => setMoving(true)}>Move to…</button>
            : <select title="Move to account" aria-label={`Move ${b.name}`} value={b.accountId || ''} onChange={e => move(month, b.id, e.target.value || null)}>
                <option value="">Unassigned</option>
                {month.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>}
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
        </span>
      </div>
      {editing && <BillDialog bill={b} onClose={() => setEditing(false)} />}
      {moving && <MoveSheet bill={b} month={month} onClose={() => setMoving(false)} />}
    </div>
  );
}

function MoveSheet({ bill: b, month, onClose }: { bill: Bill; month: Month; onClose: () => void }) {
  const pick = (to: string | null) => { move(month, b.id, to); onClose(); };
  return (
    <Modal sheet onClose={onClose} label={`Move ${b.name}`}>
      <h3>Move “{b.name}”</h3>
      <p className="lede">{fmt(b.amount)} · pick the account it’s paid from</p>
      <div className="sheetlist">
        {month.accounts.map(a => {
          const after = leftAfterMove(month, b.id, a.id);
          const cur = (b.accountId || null) === a.id;
          return (
            <button key={a.id} type="button" className={cur ? 'on' : ''} onClick={() => pick(a.id)}>
              <span className="dot" style={{ background: a.color }} />
              <span className="sn">{a.name}</span>
              <span className={`after num ${after !== null && after < 0 ? 'neg' : ''}`}>{cur ? 'Here now' : after !== null ? `${fmt(after)} left after` : ''}</span>
            </button>
          );
        })}
        <button type="button" className={!b.accountId ? 'on' : ''} onClick={() => pick(null)}><span className="sn">Unassigned</span></button>
      </div>
      <div className="dlgbtns"><button type="button" className="ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

export function BillDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const month = useStore(s => s.month)!, key = useStore(s => s.key);
  const [recurring, setRecurring] = useState(bill ? !!bill.recurring : true);
  const title = bill ? (recurring ? 'Edit bill' : 'Edit expense') : (recurring ? 'New bill' : 'New expense');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const data = {
      name: String(f.get('name') || '').trim(),
      amount: Math.abs(cents(f.get('amount'))),
      accountId: String(f.get('account') || '') || null,
      dueDay: parseInt(String(f.get('due') || ''), 10) || null,
      recurring
    };
    if (!data.name) return;
    try {
      if (bill) dispatch({ type: 'bill.update', id: bill.id, version: bill.version, patch: data });
      else dispatch({ type: 'bill.add', id: uid(), ...data });
      onClose();
    } catch (err) { toast((err as Error).message, true); }
  }
  async function del() {
    if (bill && await ask(`Delete “${bill.name}” from ${monthLabel(key)}?`, 'Delete')) {
      run(() => dispatch({ type: 'bill.remove', id: bill.id, version: bill.version }));
      onClose();
    }
  }
  return (
    <Modal onClose={onClose} label={title}>
      <form onSubmit={submit}>
        <h3>{title}</h3>
        <label htmlFor="fName">Name</label>
        <input type="text" id="fName" name="name" defaultValue={bill?.name || ''} required autoFocus />
        <div className="two">
          <div><label htmlFor="fAmt">Amount</label><input type="text" inputMode="decimal" id="fAmt" name="amount" placeholder="0.00" defaultValue={bill ? String(bill.amount) : ''} required /></div>
          <div><label htmlFor="fDue">Due day</label><input type="number" id="fDue" name="due" min={1} max={31} placeholder="Optional" defaultValue={bill?.dueDay || ''} /></div>
        </div>
        <label htmlFor="fAcct">Pays from</label>
        <select id="fAcct" name="account" defaultValue={bill?.accountId || ''}>
          <option value="">Unassigned</option>
          {month.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="chkrow"><input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} /> Recurring monthly bill</label>
        <p className="lede" style={{ margin: '4px 0 0 26px' }}>Uncheck for a one-time expense. Expenses aren’t copied to new months unless you choose to.</p>
        <div className="dlgbtns">
          {bill && <button type="button" className="del" onClick={del}>Delete</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pbtn">Save</button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') || '').trim();
    if (!name) return;
    try {
      dispatch({ type: 'account.add', id: uid(), name, balance: cents(f.get('balance')), deposit: Math.abs(cents(f.get('deposit'))) });
      onClose();
    } catch (err) { toast((err as Error).message, true); }
  }
  return (
    <Modal onClose={onClose} label="New account">
      <form onSubmit={submit}>
        <h3>New account</h3>
        <p className="lede">Adds an account to this month. It carries forward when you start a new month.</p>
        <label htmlFor="aName">Account name</label>
        <input type="text" id="aName" name="name" placeholder="e.g. Wells Fargo Savings" required autoFocus />
        <div className="two">
          <div><label htmlFor="aBal">Starting balance</label><input type="text" inputMode="decimal" id="aBal" name="balance" defaultValue="0" /></div>
          <div><label htmlFor="aDep">Monthly deposits</label><input type="text" inputMode="decimal" id="aDep" name="deposit" defaultValue="0" /></div>
        </div>
        <div className="dlgbtns">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pbtn">Add account</button>
        </div>
      </form>
    </Modal>
  );
}
