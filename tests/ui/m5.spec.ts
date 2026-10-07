import { test, expect } from '@playwright/test';

const password = 'UI test only strong password 2026';
const ownerPhone = '+998900000010';

test('M5 remembered login lists this device and the owner ends another session', async ({ page, browser, baseURL }) => {
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: /Запомнить это устройство/ }).check();
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Дом под контролем' })).toBeVisible();
  const cookie = (await page.context().cookies()).find(c => c.name === 'ijara_session');
  expect(Math.round((cookie!.expires * 1000 - Date.now()) / 86400000)).toBe(30);

  // A second device: an app session of the same owner.
  const other = await browser.newContext({ baseURL });
  const login = await other.request.post('/api/auth/login', { headers: { 'X-Ijara-Request': '1' }, data: { phone: ownerPhone, password, platform: 'ANDROID', deviceName: 'Тестовый Android' } });
  expect(login.ok()).toBe(true);
  const token = (await login.json()).token as string;

  await page.goto('/settings');
  const devices = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Мои устройства' }) });
  await expect(devices.getByRole('button', { name: 'Выйти на этом устройстве' })).toBeVisible();
  const android = devices.locator('.session-row').filter({ hasText: 'Тестовый Android' });
  await expect(android).toBeVisible();
  await android.getByRole('button', { name: 'Завершить' }).click();
  await expect(android).toHaveCount(0);
  const after = await other.request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  expect(after.status()).toBe(401);
  await other.close();
});

test('M5 settings at 390px keep the device list readable without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Дом под контролем' })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Мои устройства' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
