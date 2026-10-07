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

test('M5 staff invite a resident by link; the resident sets a password on a phone; staff close access', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const headers = { Origin: baseURL!, 'X-Ijara-Request': '1' };
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Дом под контролем' })).toBeVisible();
  const rooms = await (await page.request.get('/api/rooms')).json() as { beds: { id: string; status: string }[] }[];
  const bed = rooms.flatMap(r => r.beds).find(b => b.status === 'AVAILABLE')!;
  const resident = await (await page.request.post('/api/residents', { headers, data: { fullName: 'Приложение Тестовый', phone: '+998901777001' } })).json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const checkIn = await page.request.post('/api/occupancies/check-in', { headers, data: { residentId: resident.id, bedId: bed.id, moveInDate: today, monthlyPrice: '700000', paymentDay: 5, depositAmount: '0' } });
  expect(checkIn.ok(), await checkIn.text()).toBe(true);

  await page.goto(`/residents/${resident.id}`);
  const panel = page.locator('section.app-account');
  await expect(panel.getByText('Не приглашён')).toBeVisible();
  await panel.getByRole('button', { name: 'Пригласить по ссылке' }).click();
  const link = (await panel.locator('code').textContent())!;
  expect(link).toMatch(/\/invite#[A-Za-z0-9_-]{32,}$/);

  const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const tenant = await phone.newPage();
  await tenant.goto(new URL(link).pathname + new URL(link).hash);
  await expect(tenant.getByRole('heading', { name: 'Приложение, задайте пароль' })).toBeVisible();
  expect(tenant.url()).not.toContain('#');
  await tenant.getByLabel('Новый пароль').fill('Мой пароль жильца 1');
  await tenant.getByLabel('Повторите пароль').fill('Мой пароль жильца 1');
  await tenant.getByRole('button', { name: 'Сохранить пароль' }).click();
  await expect(tenant.getByRole('heading', { name: 'Пароль задан' })).toBeVisible();
  expect(await tenant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await phone.close();

  await page.reload();
  await expect(panel.getByText('Пользуется приложением')).toBeVisible();
  await panel.getByRole('button', { name: 'Закрыть доступ' }).click();
  await panel.getByRole('button', { name: 'Да, закрыть доступ' }).click();
  await expect(panel.getByText('Доступ закрыт')).toBeVisible();
});
