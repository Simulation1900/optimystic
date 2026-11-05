import { test as base, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { readFileSync } from 'node:fs';

export const DB = process.env.DATABASE_URL_E2E || 'postgres://planner:planner@localhost:5432/planner_e2e';
export const FIX = (n: string) => `fixtures/${n}`;
export const OWNER = { name: 'Nate', email: 'owner@example.com', password: 'a long test password' };

/** Empty every table (the server keeps running; its schema stays). */
export async function resetDb() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('TRUNCATE users, months, audit_log, category_choices, app_settings RESTART IDENTITY CASCADE');
  await c.end();
}

/** Owner created and the sample backup loaded, through the API (the UI path has its own test). */
export async function seeded(page: Page) {
  await resetDb();
  const origin = { origin: new URL(page.context()['_options']?.baseURL || 'http://localhost:8099').origin };
  let r = await page.request.post('/api/auth/setup', { data: OWNER, headers: origin });
  expect(r.ok()).toBe(true);
  r = await page.request.post('/api/import', { data: JSON.parse(readFileSync(FIX('sample-backup.json'), 'utf8')), headers: origin });
  expect(r.ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('left-over')).toHaveText('$1,176.14');
}

/** Switch tabs with the top tabs on a laptop or the bottom bar on a phone. */
export async function tab(page: Page, name: 'Bills' | 'Loans' | 'Card' | 'Settings') {
  const bar = page.locator('.tabbar');
  if (await bar.isVisible()) await bar.getByText(name, { exact: true }).click();
  else await page.locator('.tabs.top').getByRole('tab', { name: new RegExp('^' + name) }).click();
}

export const isPhone = (page: Page) => (page.viewportSize()?.width || 1000) <= 700;
export const test = base;
export { expect };
