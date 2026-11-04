import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill('+998900000010');
  await page.getByLabel('Пароль', { exact: true }).fill('UI test only strong password 2026');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^(Доброе утро|Добрый день|Добрый вечер|Доброй ночи), / })).toBeVisible();
}

test('analytics: the owner opens it from the menu, switches the period, and it fits a phone', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Аналитика' }).first().click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
  await expect(page.getByText('Заполняемость в этом месяце')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Прогноз на / })).toBeVisible();
  await expect(page.getByRole('img', { name: /^Начислено и получено: / })).toBeVisible();
  // 12 months by default; the period switch reloads the charts
  await expect(page.locator('.an-pairs > div')).toHaveCount(12);
  await page.getByRole('button', { name: '6 мес.' }).click();
  await expect(page.getByRole('button', { name: '6 мес.' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.an-pairs > div')).toHaveCount(6);
  await expect(page.getByText('Получено за 6 мес.')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
