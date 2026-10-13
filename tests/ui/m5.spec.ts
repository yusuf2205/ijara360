import { test, expect } from '@playwright/test';

const password = 'UI test only strong password 2026';
const ownerPhone = '+998900000010';

test('M5 remembered login lists this device and the owner ends another session', async ({ page, browser, baseURL }) => {
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: /Запомнить это устройство/ }).check();
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', {name:/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /})).toBeVisible();
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
  await expect(page.getByRole('heading', {name:/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /})).toBeVisible();
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
  await expect(page.getByRole('heading', {name:/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /})).toBeVisible();
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

test('M5 tickets: the owner sees the author and answers; a ticket manager sees it anonymised on a phone', async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const headers = { Origin: baseURL!, 'X-Ijara-Request': '1' };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', {name:/^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /})).toBeVisible();
  const rooms = await (await page.request.get('/api/rooms')).json() as { beds: { id: string; status: string }[] }[];
  const bed = rooms.flatMap(r => r.beds).find(b => b.status === 'AVAILABLE')!;
  const resident = await (await page.request.post('/api/residents', { headers, data: { fullName: 'Автор Обращения', phone: '+998901777002' } })).json();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  expect((await page.request.post('/api/occupancies/check-in', { headers, data: { residentId: resident.id, bedId: bed.id, moveInDate: today, monthlyPrice: '700000', paymentDay: 5, depositAmount: '0' } })).ok()).toBe(true);
  const link = (await (await page.request.post(`/api/residents/${resident.id}/app-invite`, { headers, data: { channel: 'LINK' } })).json()).link as string;
  const app = await browser.newContext({ baseURL });
  expect((await app.request.post('/api/tenant/invites/accept', { headers: { 'X-Ijara-Request': '1' }, data: { token: new URL(link).hash.slice(1), password: 'Пароль жильца для UI' } })).ok()).toBe(true);
  const token = (await (await app.request.post('/api/tenant/auth/login', { headers: { 'X-Ijara-Request': '1' }, data: { phone: '+998901777002', password: 'Пароль жильца для UI', platform: 'ANDROID' } })).json()).token as string;
  const auth = { 'X-Ijara-Request': '1', Authorization: `Bearer ${token}` };
  const ticket = await (await app.request.post('/api/tenant/tickets', { headers: auth, data: { category: 'COMPLAINT', title: 'Шумят ночью', body: 'После полуночи очень шумно.' } })).json();

  await page.goto('/');
  await expect(page.locator('.bell-count')).toBeVisible();
  await page.getByRole('link', { name: /^Уведомления: \d+ новых$/ }).click();
  const notice = page.locator('.notice-row.unread').filter({ hasText: 'Шумят ночью' });
  await expect(notice).toContainText('Новое обращение');
  await expect(notice).not.toContainText('Автор Обращения');
  await notice.click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticket.id}$`));

  await page.goto('/tickets');
  const row = page.locator('.ticket-row').filter({ hasText: 'Шумят ночью' });
  await expect(row).toContainText('Автор Обращения');
  await row.click();
  await expect(page.getByRole('link', { name: 'Автор Обращения' })).toBeVisible();
  await page.getByLabel('Ответ жильцу').fill('Поговорим с соседями сегодня.');
  await page.getByRole('button', { name: 'Отправить ответ' }).click();
  await expect(page.locator('.ticket-thread li.staff')).toContainText('Поговорим с соседями');
  await expect(page.locator('.ticket-detail .status-pill')).toHaveText('В работе');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const seen = await (await app.request.get(`/api/tenant/tickets/${ticket.id}`, { headers: auth })).json();
  expect(seen.messages.map((m: { name: string }) => m.name)).toEqual(['Вы', 'Администрация']);

  const admin = await (await page.request.post('/api/users', { headers, data: { fullName: 'Диспетчер', phone: '+998901777003', password: 'Dispatcher UI test password 2026' } })).json();
  expect((await page.request.put(`/api/permissions/users/${admin.id}`, { headers, data: { permissions: ['TICKETS_VIEW', 'TICKETS_MANAGE'] } })).ok()).toBe(true);
  const phone = await browser.newContext({ baseURL, viewport: { width: 320, height: 700 } });
  const staff = await phone.newPage();
  await staff.goto('/login');
  await staff.getByLabel('Телефон', { exact: true }).fill('+998901777003');
  await staff.getByLabel('Пароль', { exact: true }).fill('Dispatcher UI test password 2026');
  await staff.getByRole('button', { name: 'Войти', exact: true }).click();
  await staff.getByRole('navigation', { name: 'Мобильная навигация' }).getByRole('button', { name: 'Ещё' }).click();
  await staff.getByRole('navigation', { name: 'Ещё разделы' }).getByRole('link', { name: 'Обращения' }).click();
  const anon = staff.locator('.ticket-row').filter({ hasText: 'Шумят ночью' });
  await expect(anon).toBeVisible();
  await expect(anon).not.toContainText('Автор Обращения');
  await anon.click();
  await expect(staff.getByText('Автор скрыт. Его видит только владелец.')).toBeVisible();
  await expect(staff.locator('.ticket-thread li.tenant strong')).toHaveText('Жилец');
  await staff.getByRole('button', { name: 'Решено' }).click();
  await expect(staff.getByRole('button', { name: 'Открыть снова' })).toBeVisible();
  expect(await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await phone.close(); await app.close();
});
