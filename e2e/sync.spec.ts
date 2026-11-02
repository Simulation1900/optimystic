// Card sync through the real screens, against a fake SimpleFIN Bridge.
import { createServer, type Server } from 'node:http';
import { test, expect, seeded, tab, OWNER } from './helpers';

let server: Server, port = 0, claimed = 0;
const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 17) / 1000;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/claim') { claimed++; res.end(`http://u:p@127.0.0.1:${port}/sf`); return; }
    if (req.url?.startsWith('/sf/accounts')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ errors: [], accounts: [
        { id: 'A1', name: 'Chase Sapphire', org: { name: 'Chase' }, balance: '-120.00', transactions: [
          { id: 't1', posted: day('2026-11-04'), transacted_at: day('2026-11-03'), amount: '-19.99', description: 'NETFLIX.COM' },
          { id: 't2', posted: day('2026-11-05'), transacted_at: day('2026-11-04'), amount: '-100.01', description: 'KROGER #77' }
        ] },
        { id: 'A2', name: 'BoA Visa', org: { name: 'Bank of America' }, balance: '0', transactions: [] }
      ] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }));
});
test.afterAll(() => new Promise<void>(r => server.close(() => r())));

test('connect card sync, link the cards, and see the charges in the card budget', async ({ page }) => {
  await seeded(page);
  await tab(page, 'Settings');
  const card = page.getByTestId('card-sync');
  await card.getByLabel('Setup token').fill(Buffer.from(`http://127.0.0.1:${port}/claim`).toString('base64'));
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card).toContainText('No card is linked yet');
  await card.getByLabel('Chase Sapphire card').selectOption('card-chase');
  await expect(card.getByLabel('Chase Sapphire card')).toHaveValue('card-chase');
  await card.getByRole('button', { name: 'Sync now' }).click();
  await expect(card.getByTestId('sync-result')).toHaveText('Added 2 charges to November 2026.');
  await tab(page, 'Card');
  await expect(page.getByTestId('sync-line')).toContainText('Cards synced');
  await expect(page.getByTestId('budget-spent')).toHaveText('$120.00');
  await page.getByTestId('sync-line').getByRole('button', { name: 'Sync now' }).click();
  await expect(page.locator('.toast')).toContainText('No new charges.');
  await expect(page.getByTestId('budget-spent')).toHaveText('$120.00');
  expect(claimed).toBe(1);
  expect(OWNER.email).toBeTruthy();
});
