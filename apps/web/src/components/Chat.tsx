import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fmt, monthLabel } from '@optimystic/core';
import { api } from '../api';
import { dispatch, getState, openMonth, toast, useStore } from '../store';

type Change = { month: string; categoryId: string; name: string; from: number; to: number; undone?: boolean };
type Msg = { role: 'user' | 'assistant' | 'error'; content: string; changes?: Change[] };

const STARTERS = ['Where did most of this month’s card money go?', 'How much will this month’s shortfall add to the HELOC?', 'Raise Dining out to $175', 'Am I on track with my goals?'];

/** Ask: a chat about the household's money. It reads everything and can change card budget limits (with Undo). */
export function ChatPanel({ onClose }: { onClose: () => void }) {
  const key = useStore(s => s.key);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ available: boolean; messages: Msg[] }>('GET', '/api/chat').then(r => { setAvailable(r.available); setMsgs(r.messages); }).catch(() => setAvailable(false));
    setTimeout(() => input.current?.focus(), 50);
  }, []);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [msgs]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);

  const patchLast = (f: (m: Msg) => Msg) => setMsgs(xs => { const out = xs.slice(); const i = out.length - 1; if (out[i]?.role === 'assistant') out[i] = f(out[i]); return out; });

  async function send(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true); setText('');
    setMsgs(xs => [...xs, { role: 'user', content: q.trim() }, { role: 'assistant', content: '' }]);
    try {
      const r = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q.trim(), month: key }) });
      if (!r.ok || !r.body) {
        let m = `Chat isn’t available (${r.status}).`;
        try { const j = await r.json(); if (j.error) m = j.error; } catch { /* keep */ }
        setMsgs(xs => [...xs.slice(0, -1), { role: 'error', content: m }]);
        return;
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line.slice(5)); } catch { continue; }
          if (e.type === 'text') patchLast(m => ({ ...m, content: m.content + String(e.text) }));
          else if (e.type === 'change') {
            const ch = e as unknown as Change;
            patchLast(m => ({ ...m, changes: [...(m.changes ?? []), ch] }));
            if (ch.month === getState().key) void openMonth(ch.month);
          } else if (e.type === 'error') setMsgs(xs => [...xs.filter((x, i) => !(i === xs.length - 1 && x.role === 'assistant' && !x.content && !x.changes)), { role: 'error', content: String(e.message) }]);
        }
      }
    } catch {
      setMsgs(xs => [...xs, { role: 'error', content: 'Lost the connection. Try again.' }]);
    } finally {
      setBusy(false);
      setMsgs(xs => xs.filter((x, i) => !(i === xs.length - 1 && x.role === 'assistant' && !x.content && !x.changes)));
    }
  }

  async function undo(mi: number, ci: number) {
    const ch = msgs[mi].changes![ci];
    try {
      if (getState().key !== ch.month) await openMonth(ch.month);
      const cat = getState().month?.budget.cats.find(c => c.id === ch.categoryId);
      if (!cat) throw new Error('That category is gone.');
      dispatch({ type: 'cat.update', id: cat.id, version: cat.version, patch: { limit: ch.from } });
      setMsgs(xs => xs.map((m, i) => (i !== mi ? m : { ...m, changes: m.changes!.map((c, j) => (j === ci ? { ...c, undone: true } : c)) })));
      toast(`${ch.name} is back to ${fmt(ch.from)}.`);
    } catch (e) { toast((e as Error).message, true); }
  }

  async function clear() {
    await api('DELETE', '/api/chat').catch(() => undefined);
    setMsgs([]);
  }

  function submit(e: FormEvent) { e.preventDefault(); void send(text); }

  return (
    <aside className="chat" role="dialog" aria-label="Ask about your money">
      <div className="chathead">
        <b>Ask</b><span className="hnote">{key ? `about ${monthLabel(key)} and before` : ''}</span>
        <span style={{ flex: 1 }} />
        {msgs.length > 0 && <button className="mini" onClick={clear} disabled={busy}>Clear</button>}
        <button className="x" aria-label="Close chat" onClick={onClose}>×</button>
      </div>
      <div className="chatmsgs" ref={box} aria-live="polite">
        {available === false && <div className="cm error">Chat is off: no Claude API key is set on the server.</div>}
        {available && !msgs.length && (
          <div className="cm assistant">
            Ask anything about your bills, cards, loans, HELOC or goals. I can also change a card budget limit if you ask.
            <div className="starters">{STARTERS.map(s => <button key={s} className="mini" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`cm ${m.role}`}>
            {m.content || (busy && i === msgs.length - 1 ? <span className="dots" aria-label="Thinking"><i /><i /><i /></span> : '')}
            {m.changes?.map((c, j) => (
              <div key={j} className="change">
                <span>{c.name} in {monthLabel(c.month)}: {fmt(c.from)} → <b>{fmt(c.to)}</b></span>
                {c.undone ? <span className="hnote">Undone</span> : <button className="mini" onClick={() => undo(i, j)}>Undo</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <form className="chatin" onSubmit={submit}>
        <textarea ref={input} rows={2} value={text} maxLength={4000} disabled={!available} placeholder={available ? 'Ask about your money…' : ''} aria-label="Message"
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <button className="pbtn" style={{ marginLeft: 0 }} disabled={!available || busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
