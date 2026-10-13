import { test, expect } from '@playwright/test';

const password = 'UI test only strong password 2026';
const ownerPhone = '+998900000010';
// The NAS test gateway publishes the same Caddy rules as production: 3187 is the tailnet listener, 3188 the internet one.
const internetOrigin = 'http://100.126.164.29:3188';
const greeting = /^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /;
async function login(page: import('@playwright/test').Page) {
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

test('M5 internet login: a new device without Telegram is refused, a device trusted at home goes straight in', async ({ browser, baseURL }) => {
  test.skip(!process.env.TEST_WEB_ORIGIN, 'needs the NAS test gateway with its internet listener');
  const stranger = await browser.newContext({ baseURL: internetOrigin, viewport: { width: 390, height: 844 } });
  const away = await stranger.newPage();
  await away.goto('/login');
  await expect(away.getByText('Вход через интернет: с нового устройства нужно будет подтвердить вход в Telegram.')).toBeVisible();
  await login(away);
  await expect(away.locator('.error')).toContainText('привяжите Telegram в настройках');
  expect((await stranger.cookies()).some(c => c.name === 'ijara_session')).toBe(false);
  await stranger.close();

  const laptop = await browser.newContext({ baseURL });
  const home = await laptop.newPage();
  await home.goto('/login');
  await expect(home.getByText(/Вход через интернет/)).toHaveCount(0);
  await login(home);
  await expect(home.getByRole('heading', { name: greeting })).toBeVisible();
  await home.goto('/settings');
  await expect(home.getByRole('button', { name: 'Привязать Telegram' })).toBeVisible();
  const trusted = home.locator('section').filter({ has: home.getByRole('heading', { name: 'Доверенные устройства' }) });
  await expect(trusted.locator('.session-row').first()).toBeVisible();
  // Same laptop, now outside: cookies follow the host, so the trusted device skips the Telegram step.
  await home.context().clearCookies({ name: 'ijara_session' });
  await home.goto(internetOrigin + '/login');
  await login(home);
  await expect(home.getByRole('heading', { name: greeting })).toBeVisible();
  expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await laptop.close();
});
