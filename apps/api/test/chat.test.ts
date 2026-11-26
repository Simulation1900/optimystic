import { describe, expect, it } from 'vitest';
import { setAiClientForTests } from '../src/aiadvice.js';
import { fixture, owner, start, stop, type Ctx } from './setup.js';

type Turn = { text: string; tool?: { name: string; input: unknown } };

/** A fake Claude that streams each scripted turn's text, then (optionally) asks for one tool call. */
function fakeClaude(turns: Turn[], seen: Array<Record<string, unknown>>) {
  let i = 0;
  return () => ({ messages: { stream: (params: Record<string, unknown>) => {
    seen.push(JSON.parse(JSON.stringify(params)));
    const t = turns[i++];
    const events = [...t.text].length ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: t.text } }] : [];
    const content: unknown[] = t.text ? [{ type: 'text', text: t.text }] : [];
    if (t.tool) content.push({ type: 'tool_use', id: `tu_${i}`, name: t.tool.name, input: t.tool.input });
    return {
      async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
      finalMessage: async () => ({ model: 'claude-sonnet-5-5', stop_reason: t.tool ? 'tool_use' : 'end_turn', content,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 20000 } })
    };
  } } }) as never;
}

const events = (body: string) => body.split('\n\n').filter(Boolean).map(p => JSON.parse(p.replace(/^data: /, '')));

describe('Ask (chat)', () => {
  it('answers from the household data, changes a budget limit when asked, and keeps the conversation', async () => {
    const ctx: Ctx = await start({ ANTHROPIC_API_KEY: 'sk-test' });
    try {
      const c = await owner(ctx);
      await c.post('/api/import', JSON.parse(fixture('sample-backup.json')));
      const key = (await c.get('/api/months')).json().months.slice(-1)[0];
      const month = (await c.get(`/api/months/${key}`)).json().month;
      const cat = month.budget.cats[0];
      const seen: Array<Record<string, unknown>> = [];
      setAiClientForTests(fakeClaude([
        { text: 'Raising it now.', tool: { name: 'set_category_limit', input: { category_id: cat.id, new_limit: 175 } } },
        { text: `Done: ${cat.name} is now $175.` }
      ], seen));
      const r = await c.post('/api/chat', { message: `Raise ${cat.name} to $175`, month: key });
      expect(r.statusCode).toBe(200);
      const ev = events(r.body);
      expect(ev.map(e => e.type)).toEqual(['text', 'change', 'text', 'text', 'done']);
      expect(ev[1]).toMatchObject({ month: key, categoryId: cat.id, to: 175 });
      expect((await c.get(`/api/months/${key}`)).json().month.budget.cats[0].limit).toBe(175);
      // the data block is cached, the tool is offered, and the month being viewed is named
      const first = seen[0] as { system: Array<{ cache_control?: unknown; text: string }>; tools: Array<{ name: string }>; messages: Array<{ content: string }> };
      expect(first.system[1].cache_control).toEqual({ type: 'ephemeral' });
      expect(first.system[1].text).toContain('card_budget');
      expect(first.tools.map(t => t.name)).toEqual(['set_category_limit']);
      expect(first.messages.at(-1)!.content).toContain(`(Viewing ${key}.)`);
      const hist = (await c.get('/api/chat')).json().messages;
      expect(hist.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);

      // a bad tool call comes back to Claude as an error and changes nothing
      setAiClientForTests(fakeClaude([
        { text: '', tool: { name: 'set_category_limit', input: { category_id: 'nope', new_limit: 50 } } },
        { text: 'I couldn’t find that category.' }
      ], seen));
      const bad = events((await c.post('/api/chat', { message: 'Set nope to 50', month: key })).body);
      expect(bad.some(e => e.type === 'change')).toBe(false);
      const toolResult = (seen.at(-1) as { messages: Array<{ content: Array<{ is_error?: boolean }> | string }> }).messages.at(-1)!.content as Array<{ is_error?: boolean }>;
      expect(toolResult[0].is_error).toBe(true);

      expect((await c.del('/api/chat')).statusCode).toBe(200);
      expect((await c.get('/api/chat')).json().messages).toEqual([]);
      expect((await c.post('/api/chat', { message: ' ' })).statusCode).toBe(400);
    } finally {
      setAiClientForTests(null);
      await stop(ctx);
    }
  });

  it('is off without a key', async () => {
    const ctx = await start();
    try {
      const c = await owner(ctx);
      expect((await c.get('/api/chat')).json().available).toBe(false);
      expect((await c.post('/api/chat', { message: 'hi' })).statusCode).toBe(400);
    } finally { await stop(ctx); }
  });
});
