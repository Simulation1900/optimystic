import { describe, expect, it } from 'vitest';
import { setAiClientForTests } from '../src/aiadvice.js';
import { fixture, owner, start, stop, type Client, type Ctx } from './setup.js';

describe('Refresh advice through the Claude API', () => {
  it('is off without a key', async () => {
    const ctx = await start();
    try {
      const c: Client = await owner(ctx);
      expect((await c.get('/api/advice/ai')).json().available).toBe(false);
      expect((await c.post('/api/advice/refresh', {})).statusCode).toBe(400);
    } finally { await stop(ctx); }
  });

  it('refreshes advice through the Claude API, costs it, and stops at the monthly cap', async () => {
    let sent: { system?: string; messages?: Array<{ content: string }> } = {};
    const reply = (text: string, stop = 'end_turn') => ({ model: 'claude-opus-5-5', stop_reason: stop, usage: { input_tokens: 30000, output_tokens: 8000 },
      content: [{ type: 'text', text }] });
    let next = reply('Here you go:\n```json\n{"format":"billplanner-advice/1","summary":["From the API."],"recommendations":[{"title":"Cut dining","detail":"x","area":"card_budget","priority":"high","monthly_impact":50}]}\n```');
    setAiClientForTests(() => ({ messages: { stream: (p: typeof sent) => { sent = p; return { finalMessage: async () => next }; } } }) as never);
    const ctx2: Ctx = await start({ ANTHROPIC_API_KEY: 'sk-test', AI_MONTHLY_BUDGET_USD: '0.5' });
    try {
      const c2 = await owner(ctx2);
      await c2.post('/api/import', JSON.parse(fixture('sample-backup.json')));
      expect((await c2.get('/api/advice/ai')).json()).toMatchObject({ available: true, model: 'claude-opus-5-5', spentUsd: 0, capUsd: 0.5 });
      const r = await c2.post('/api/advice/refresh', { months: 3, question: 'Can we pay the car off?' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ recommendations: 1, costUsd: 0.28 });
      expect(sent.system).toContain('reply with ONLY the billplanner-advice/1 JSON');
      expect(sent.messages![0].content).toContain('Can we pay the car off?');
      const adv = (await c2.get('/api/advice')).json().advice;
      expect(adv).toMatchObject({ summary: ['From the API.'], question: 'Can we pay the car off?' });
      expect((await c2.get('/api/advice/ai')).json().spentUsd).toBe(0.28);
      next = reply('not json at all');
      expect((await c2.post('/api/advice/refresh', {})).statusCode).toBe(502);
      expect((await c2.post('/api/advice/refresh', {})).statusCode).toBe(429);  // $0.56 spent of $0.50
    } finally {
      setAiClientForTests(null);
      await stop(ctx2);
    }
  });

});
