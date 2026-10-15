import { test, expect } from '@playwright/test';

const password = 'UI test only strong password 2026';
const ownerPhone = '+998900000010';

// On the NAS test stack a watchdog container writes the status file the API reads (docs/M6-RELIABILITY.md).
test('M6 server panel: the owner sees every check, the last backup and free space on a phone', async ({ page }) => {
  test.skip(!process.env.TEST_WEB_ORIGIN, 'needs the NAS test stack with its watchdog');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(ownerPhone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
  await page.goto('/settings');
  const panel = page.getByRole('region', { name: 'Сервер' });
  await expect(panel).toBeVisible();
  for (const label of ['Сервер приложения', 'База данных', 'Вход через Tailscale', 'Вход из интернета', 'Вход из домашней сети', 'Ночная резервная копия', 'Копия в облаке', 'Копия на USB-диске', 'Место на диске', 'Обновления в реальном времени', 'Геолокация: приём', 'Геолокация: статусы', 'Геолокация: очистка истории', 'Карта (Яндекс)']) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(panel.getByText(/^(Всё работает|Есть проблемы: \d+)$/)).toBeVisible();
  await expect(panel.getByText('Последняя копия')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
