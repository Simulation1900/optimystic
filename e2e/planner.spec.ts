import { test, expect, resetDb, seeded, tab, isPhone, FIX, OWNER } from './helpers';

test('first run: create the owner and import a backup, with every figure matching', async ({ page }) => {
  await resetDb();
  await page.goto('/');
  await page.getByLabel('Your name').fill(OWNER.name);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Create owner login' }).click();
  await page.getByRole('button', { name: 'Load a backup' }).click();
  await page.getByTestId('backup-input').setInputFiles(FIX('sample-backup.json'));
  await expect(page.getByTestId('import-check')).toContainText('Every figure matches');
  await expect(page.getByTestId('import-check').locator('.badv')).toHaveCount(0);
  await tab(page, 'Bills');
  await expect(page.getByTestId('left-over')).toHaveText('$1,176.14');
  await expect(page.getByTestId('left-chk1')).toHaveText('$1,321.76');
});

test('marking the mortgage paid applies it to the loan', async ({ page }) => {
  await seeded(page);
  await page.getByLabel('Mark Mortgage paid').check();
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  await expect(page.getByTestId('left-over')).toHaveText('$1,176.14'); // paid is only a marker
  await tab(page, 'Loans');
  await expect(page.getByTestId('loan-balance-mortgage')).toHaveText('$215,531.12');
  await expect(page.locator('[data-loan="mortgage"]')).toContainText('$495.12 interest, $523.03 principal, $631.48 escrow');
  // and it survives a reload (it reached the server)
  await page.reload();
  await expect(page.getByTestId('loan-balance-mortgage')).toHaveText('$215,531.12');
});

test('moving a bill and covering a shortfall from the HELOC', async ({ page }) => {
  await seeded(page);
  const card = page.locator('[data-bill="Streaming"]');
  if (isPhone(page)) {
    await card.getByRole('button', { name: 'Move to…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Joint Checking/ }).click();
  } else {
    await card.dragTo(page.locator('[data-account="chk2"]'));
  }
  await expect(page.locator('[data-account="chk2"] [data-bill="Streaming"]')).toBeVisible();
  await expect(page.getByTestId('left-chk2')).toHaveText('$454.38');
  await tab(page, 'Loans');
  await expect(page.locator('#hShort')).toContainText('Savings');
  await page.getByRole('button', { name: /Cover all · \$600\.00/ }).click();
  await expect(page.locator('#hShort')).toContainText('Every account covers its bills this month');
  await expect(page.locator('#hShort .drawlog')).toContainText('$600.00 → Savings');
  await tab(page, 'Bills');
  await expect(page.getByTestId('left-sav1')).toHaveText('$0.00');
  await tab(page, 'Loans');
  await page.locator('#hShort .drawlog').getByRole('button', { name: 'Undo' }).click();
  await tab(page, 'Bills');
  await expect(page.getByTestId('left-sav1')).toHaveText('-$600.00');
});

test('card budget: add an expense, import a CSV, start a new month', async ({ page }) => {
  await seeded(page);
  // October has to exist for the CSV's October lines
  await page.getByRole('button', { name: 'New month' }).click();
  await page.getByLabel('New month', { exact: true }).fill('2026-10');
  await page.getByRole('button', { name: 'Create month' }).click();
  await expect(page.locator('.monthnav h1')).toContainText('October 2026');
  await page.getByLabel('Switch month').selectOption('2026-11');
  await expect(page.locator('.monthnav h1')).toContainText('November 2026');
  await tab(page, 'Card');

  if (isPhone(page)) await page.getByRole('button', { name: 'Add an expense' }).click();
  const form = isPhone(page) ? page.getByRole('dialog') : page.locator('.addcard');
  await form.getByLabel('Description').fill('KROGER #12');
  await expect(form.getByLabel('Category')).toHaveValue('cat-groceries'); // guessed as you type
  await form.getByLabel('Amount').fill('45.10');
  await form.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByTestId('budget-spent')).toHaveText('$45.10');

  await page.getByLabel('Card the file is from').selectOption('card-chase');
  await page.getByTestId('csv-input').setInputFiles(FIX('sample-card-activity.csv'));
  await expect(page.getByTestId('csv-status')).toHaveText('✓ Added 10 expenses to October 2026, November 2026. 1 skipped (no planner month for their date — create that month first).');
  await expect(page.getByTestId('budget-spent')).toHaveText('$170.64');
  await page.getByTestId('csv-input').setInputFiles(FIX('sample-card-activity.csv'));
  await expect(page.getByTestId('csv-status')).toContainText('Nothing new to add. 10 already logged.');

  await page.getByRole('button', { name: 'New month' }).click();
  await page.getByLabel('New month', { exact: true }).fill('2026-12');
  await page.getByLabel('Copy from').selectOption('2026-11');
  await page.getByLabel('Credit card bills').selectOption('actual');
  await expect(page.getByRole('dialog')).toContainText('“Chase Credit Bill” → $125.54');
  await page.getByRole('button', { name: 'Create month' }).click();
  await expect(page.locator('.monthnav h1')).toContainText('December 2026');
  await expect(page.locator('[data-bill="Chase Credit Bill"] .amt')).toHaveText('$125.54');
  await expect(page.locator('[data-bill="BoA Credit Bill"] .amt')).toHaveText('$45.10');
  await expect(page.locator('[data-bill="Birthday gift"]')).toHaveCount(0);
});

test('a second login sees changes from the first after a refresh', async ({ page, browser }) => {
  await seeded(page);
  const origin = { origin: new URL(page.url()).origin };
  await page.request.post('/api/users', { data: { name: 'Dejuania', email: 'member@example.com', password: 'another long password' }, headers: origin });
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 800 } });
  const p2 = await other.newPage();
  await p2.goto('/');
  await p2.getByLabel('Email').fill('member@example.com');
  await p2.getByLabel('Password').fill('another long password');
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await expect(p2.getByTestId('left-chk1')).toHaveText('$1,321.76');
  await page.getByLabel('Sample Checking starting balance').fill('1000');
  await page.getByLabel('Sample Checking starting balance').press('Enter');
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  await p2.reload();
  await expect(p2.getByTestId('left-chk1')).toHaveText('$1,741.76');
  await other.close();
});

test('two phones edit the same bill: the second is told and shown the latest', async ({ page, browser }) => {
  await seeded(page);
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await page.context().storageState() });
  const p2 = await other.newPage();
  await p2.goto('/');
  await expect(p2.getByTestId('left-over')).toHaveText('$1,176.14');
  // first device renames the bill
  await page.locator('[data-bill="Streaming"]').hover();
  await page.locator('[data-bill="Streaming"]').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Amount').fill('20');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  // second device still has the old version on screen
  await p2.locator('[data-bill="Streaming"]').hover();
  await p2.locator('[data-bill="Streaming"]').getByRole('button', { name: 'Edit' }).click();
  await p2.getByLabel('Amount').fill('25');
  await p2.getByRole('button', { name: 'Save' }).click();
  await expect(p2.locator('.toast')).toContainText('Someone else changed that first');
  await expect(p2.locator('[data-bill="Streaming"] .amt')).toHaveText('$20.00');
  await other.close();
});

test('quick-add suggests the category you filed a store under before', async ({ page }) => {
  await seeded(page);
  await tab(page, 'Card');
  const add = async (desc: string) => {
    if (isPhone(page)) await page.getByRole('button', { name: 'Add an expense' }).click();
    const form = isPhone(page) ? page.getByRole('dialog') : page.locator('.addcard');
    await form.getByLabel('Description').fill(desc);
    return form;
  };
  // the keyword rules don't know this store: it goes to Other
  let form = await add('Sample General Store #12');
  await expect(form.getByLabel('Category')).toHaveValue('cat-other');
  await expect(form.getByTestId('cat-from-past')).toHaveCount(0);
  await form.getByLabel('Amount').fill('30');
  await form.getByRole('button', { name: 'Add expense' }).click();
  // re-file it under Groceries in the expenses list (phones hide that column, so they save the same change directly)
  if (isPhone(page)) {
    const month = await (await page.request.get('/api/months/2026-11')).json();
    const e = month.month.budget.expenses.find((x: { desc: string }) => x.desc === 'Sample General Store #12');
    await page.request.patch(`/api/months/2026-11/budget/expenses/${e.id}`, { data: { catId: 'cat-groceries' }, headers: { origin: new URL(page.url()).origin } });
    await page.reload();
  } else {
    await page.getByLabel('Sample General Store #12 category').selectOption('cat-groceries');
  }
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  form = await add('SAMPLE GENERAL STORE #40');
  await expect(form.getByLabel('Category')).toHaveValue('cat-groceries');
  await expect(form.getByTestId('cat-from-past')).toBeVisible();
});

test('light and dark mode: the header toggle and the Settings choice, remembered on this device', async ({ page }) => {
  await seeded(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(light);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await tab(page, 'Settings');
  await page.getByRole('radio', { name: 'Match this device' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await bg()).toBe(light); // the test browser's device setting is light
});

test('transfers: cover a short account from one with money to spare, mark it done, carry a monthly one forward', async ({ page }) => {
  await seeded(page);
  // Savings is $600 short; its card offers a transfer prefilled from the account with the most to spare
  await page.getByRole('button', { name: 'Cover $600.00 with a transfer' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('From')).toHaveValue('chk1');
  await expect(dlg.getByLabel('To')).toHaveValue('sav1');
  await expect(dlg.getByLabel('Amount')).toHaveValue('600.00');
  await expect(dlg.getByTestId('transfer-preview')).toContainText('Ending balances: Sample Checking $721.76 · Savings $0.00');
  await dlg.getByLabel('Every month').check();
  await dlg.getByRole('button', { name: 'Add transfer' }).click();
  await expect(page.getByTestId('left-sav1')).toHaveText('$0.00');
  await expect(page.getByTestId('left-chk1')).toHaveText('$721.76');
  await expect(page.getByTestId('xout-chk1')).toHaveText('−$600.00');
  await expect(page.getByTestId('left-over')).toHaveText('$1,176.14'); // money stays in the household
  await page.getByLabel('Mark $600.00 transfer done').check();
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  await expect(page.locator('.xrow.done')).toHaveCount(1);
  // a one-off transfer from the header button
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  await page.getByRole('dialog').getByLabel('From').selectOption('chk2');
  await page.getByRole('dialog').getByLabel('To').selectOption('chk1');
  await page.getByRole('dialog').getByLabel('Amount').fill('70');
  await page.getByRole('dialog').getByRole('button', { name: 'Add transfer' }).click();
  await expect(page.getByTestId('left-chk2')).toHaveText('$400.37');
  // next month: only the monthly one comes along, not done
  await page.getByRole('button', { name: 'New month' }).click();
  await page.getByLabel('New month', { exact: true }).fill('2026-12');
  await page.getByRole('button', { name: 'Create month' }).click();
  await expect(page.locator('.monthnav h1')).toContainText('December 2026');
  await expect(page.locator('.xrow')).toHaveCount(1);
  await expect(page.locator('.xrow.done')).toHaveCount(0);
  await expect(page.locator('.xrow')).toContainText('Every month');
});

test('a tapped notification’s link opens the right tab', async ({ page }) => {
  await seeded(page);
  await page.goto('/?tab=budget');
  await expect(page.getByTestId('budget-spent')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/?tab=settings');
  await expect(page.getByTestId('notifications')).toBeVisible();
});

test('a card with a closing day: its bill follows the statement that closes this month', async ({ page }) => {
  await seeded(page);
  await tab(page, 'Card');
  await page.getByLabel('Chase statement closing day').fill('21');
  await page.getByLabel('Chase statement closing day').press('Enter');
  await page.getByLabel('Chase payment due day').fill('19');
  await page.getByLabel('Chase payment due day').press('Enter');
  const tile = page.getByTestId('statement-card-chase');
  await expect(tile).toContainText('Statement Oct 22 – Nov 21');
  await expect(tile).toContainText('due Dec 19');
  await expect(tile).toContainText('isn’t in the planner'); // October isn't there, so the total may be short
  await expect(page.locator('.syncpill')).toHaveText('Saved');
  const amount = (await tile.locator('.kv').nth(1).locator('b').textContent())!;
  await tab(page, 'Bills');
  await expect(page.locator('[data-bill="Chase Credit Bill"] .amt')).toHaveText(amount);
});
