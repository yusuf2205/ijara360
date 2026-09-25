import { defineConfig } from '@playwright/test';
process.loadEnvFile('.env.test');
const remoteWeb = process.env.TEST_WEB_ORIGIN;
if (remoteWeb && remoteWeb !== 'http://100.126.164.29:3187') throw new Error('Remote UI tests are restricted to the dedicated NAS test gateway.');
export default defineConfig({
  testDir: './tests/ui',
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: remoteWeb || 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: remoteWeb ? undefined : { command: 'npm run dev:web', url: 'http://localhost:3000/login', reuseExistingServer: !process.env.CI, timeout: 120000,
    env: { NODE_ENV: 'development', API_INTERNAL_URL: process.env.TEST_API_ORIGIN || 'http://127.0.0.1:4000' } },
});
