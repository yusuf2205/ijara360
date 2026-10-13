import { test, expect, type Page } from '@playwright/test';

// The Flutter app at /app exposes its semantics tree (see apps/mobile/lib/main.dart), so it is tested by roles and labels.
const greeting = /(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), /;

async function signIn(page: Page, who: 'Я жилец' | 'Я сотрудник', phone: string, password: string) {
  await page.goto('/app/');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: who }).click();
  await page.getByRole('textbox', { name: 'Телефон' }).fill(phone);
  // Flutter's obscured field takes real key presses, as a person would type.
  await page.getByRole('textbox', { name: 'Пароль' }).click();
  await page.keyboard.type(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test('the app on a phone: staff sign in, see the house and switch sections from the bottom bar', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'Я сотрудник', '+998900000010', 'UI test only strong password 2026');
  await expect(page.getByRole('heading', { name: greeting })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: /^Всего мест: \d+$/ })).toBeVisible();
  await expect(page.getByText('План дома')).toBeVisible();
  await page.getByRole('tab', { name: /Жильцы/ }).click();
  await expect(page.getByRole('textbox', { name: /Имя или телефон/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the app on a desktop: a resident signs in and sees their place, money and sections in a side menu', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 860 });
  // The resident from the M5 ticket test (tests/ui/m5.spec.ts) set this password through the invite link.
  await signIn(page, 'Я жилец', '+998901777002', 'Пароль жильца для UI');
  await expect(page.getByRole('heading', { name: greeting })).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel(/Моё место: комната \d+, место \d+-\d+/)).toBeVisible();
  // On wide screens the sections are a side menu (buttons), on phones a bottom tab bar.
  await expect(page.getByRole('button', { name: 'Платежи', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Обращения', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Шумят ночью/ })).toBeVisible();
});
