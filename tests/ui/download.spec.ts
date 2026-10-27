import { expect, test } from '@playwright/test';

// ijara360.uz/download opens the right install path for the visitor's device; every tab stays reachable.
const cases = [
  { name: 'Android phone', ua: 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36', tab: 'Android', href: '/app/ijara360.apk' },
  { name: 'iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', tab: 'iPhone и iPad', href: '/app/' },
  { name: 'iPad (reports itself as a Mac)', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', tab: 'iPhone и iPad', href: '/app/', touch: true },
  { name: 'Windows computer', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36', tab: 'Компьютер', href: '/app/?install=1' },
];

for (const c of cases) {
  test(`download page picks the install path for ${c.name}`, async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: c.ua, viewport: { width: 390, height: 844 } });
    if (c.touch) await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
    const page = await ctx.newPage();
    await page.goto('/download');
    await expect(page.getByRole('tab', { selected: true })).toHaveText(c.tab);
    await expect(page.locator('.download-button')).toHaveAttribute('href', c.href);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await ctx.close();
  });
}

test('every device tab can be chosen by hand', async ({ page }) => {
  await page.goto('/download');
  await page.getByRole('tab', { name: 'Android' }).click();
  await expect(page.locator('.download-button')).toHaveAttribute('href', '/app/ijara360.apk');
  await page.getByRole('tab', { name: 'iPhone и iPad' }).click();
  await expect(page.getByText('На экран «Домой»')).toBeVisible();
  await page.getByRole('tab', { name: 'Компьютер' }).click();
  await expect(page.locator('.download-button')).toHaveText('Установить на компьютер');
});
