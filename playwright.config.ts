import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the built app (apps/api/dist + apps/web/dist) against a scratch database.
const DB = process.env.DATABASE_URL_E2E || 'postgres://planner:planner@localhost:5432/planner_e2e';
const PORT = 8099;
export const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: BASE, trace: 'retain-on-failure' },
  projects: [
    { name: 'laptop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } }
  ],
  webServer: {
    command: 'node apps/api/dist/index.js',
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    env: { DATABASE_URL: DB, SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e', PUBLIC_URL: BASE, PORT: String(PORT), WEB_DIST: 'apps/web/dist', LOGIN_LIMIT: '1000' }
  }
});
