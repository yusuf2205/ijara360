import { test, expect, type Page } from '@playwright/test';
const phone = '+998900000010';
const password = 'UI test only strong password 2026';
async function login(page: Page, account = phone) {
  await page.goto('/login');
  await expect(page.getByRole('heading', {name:'Войти в свой дом'})).toBeVisible();
  await page.getByLabel('Телефон', { exact:true }).fill(account);
  await page.getByLabel('Пароль', { exact:true }).fill(password);
  await page.getByRole('button', {name:'Войти', exact:true}).click();
  await expect(page.getByRole('heading', {name:'Дом под контролем'})).toBeVisible();
}
test.describe.configure({mode:'serial'});
test('first-run setup creates the owner and 7 rooms; login opens overview', async ({page, request}) => {
  const state=await request.get('/api/auth/setup-status');
  expect((await state.json()).configured, 'Use the dedicated empty test database, never production').toBe(false);
  await page.goto('/login');
  await page.getByLabel('Ключ первоначальной настройки').fill(process.env.SETUP_TOKEN!);
  await page.getByLabel('Ваше имя').fill('Тестовый владелец');
  await page.getByLabel('Телефон', {exact:true}).fill(phone);
  await page.getByLabel('Пароль', {exact:false}).fill(password);
  await page.getByRole('button',{name:'Продолжить'}).click();
  await page.getByLabel('Название дома').fill('Студенческий дом');
  await page.getByLabel('Количество комнат').fill('7');
  await page.getByLabel('Мест в каждой').fill('8');
  await page.getByRole('button',{name:'Создать дом'}).click();
  await expect(page.getByRole('heading',{name:'Дом под контролем'})).toBeVisible();
  await expect(page.locator('.room-card')).toHaveCount(7);
  await expect(page.locator('.stat').nth(1).locator('strong')).toHaveText('56');
  const cookie=(await page.context().cookies()).find(c=>c.name==='ijara_session');
  expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict');
});
test('desktop overview and room detail show real data without horizontal overflow', async ({page}) => {
  await page.setViewportSize({width:1440,height:1100}); await login(page);
  await page.screenshot({path:'.local/screenshots/overview-desktop.png',fullPage:true});
  await page.getByRole('heading',{name:'Комната №1',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Комната №1',exact:true})).toBeVisible();
  await expect(page.locator('.bed-card')).toHaveCount(8);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('mobile rooms: create a room and a bed, then reload to verify persistence', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await login(page);
  await page.getByRole('button',{name:'Добавить комнату'}).click();
  await page.getByLabel('Номер комнаты').fill('8');
  await page.getByLabel('Вместимость',{exact:true}).fill('9');
  await page.getByLabel('Создать мест').fill('2');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.locator('.room-card')).toHaveCount(8);
  await page.getByRole('heading',{name:'Комната №8',exact:true}).click();
  await expect(page.locator('.bed-card')).toHaveCount(2);
  await page.getByRole('button',{name:'Добавить место'}).click();
  await page.getByLabel('Номер места').fill('3');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.locator('.bed-card')).toHaveCount(3);
  await page.reload(); await expect(page.locator('.bed-card')).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'.local/screenshots/room-mobile.png',fullPage:true});
});
test('duplicate room error preserves user input and dialog can be closed by Escape', async ({page}) => {
  await login(page); await page.getByRole('button',{name:'Добавить комнату'}).click();
  await page.getByLabel('Номер комнаты').fill('1');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('уже существует');
  await expect(page.getByLabel('Номер комнаты')).toHaveValue('1');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('search, dashboard links and history navigation work on 320px screens', async ({page}) => {
  await page.setViewportSize({width:320,height:740}); await login(page);
  await page.locator('.stat').first().click();
  await expect(page.getByRole('heading',{name:'Комнаты',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Найти комнату'}).fill('8');
  await expect(page.locator('.room-card')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('navigation',{name:'Мобильная навигация'}).getByRole('link',{name:'История'}).click();
  await expect(page.getByRole('heading',{name:'История действий'})).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('Добавлено место');
});
test('owner creates ADMIN; ADMIN cannot see owner controls', async ({page}) => {
  await login(page); await page.goto('/settings');
  await page.getByRole('button',{name:'Управляющий',exact:true}).click();
  await page.getByLabel('ФИО').fill('Тестовый управляющий');
  await page.getByLabel('Телефон',{exact:true}).fill('+998900000011');
  await page.getByLabel('Начальный пароль').fill(password);
  await page.getByRole('dialog').getByRole('button',{name:'Сохранить',exact:true}).click();
  await expect(page.locator('.staff-list')).toContainText('Тестовый управляющий');
  await page.getByRole('button',{name:'Выйти',exact:true}).click();
  await login(page,'+998900000011');
  await expect(page.getByRole('button',{name:'Добавить комнату'})).toHaveCount(0);
  await page.goto('/rooms'); await expect(page.locator('.room-card')).toHaveCount(8);
});
test('capacity card filters rooms and mobile settings allow logout', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await login(page);
  await page.locator('.stat').filter({hasText:'Можно добавить'}).click();
  await expect(page.locator('.room-card')).toHaveCount(1);
  await expect(page.locator('.room-card')).toContainText('Комната №8');
  await page.goto('/settings');
  await page.getByRole('button',{name:'Выйти из аккаунта'}).click();
  await expect(page.getByRole('heading',{name:'Войти в свой дом'})).toBeVisible();
});
