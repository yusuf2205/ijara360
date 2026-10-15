import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// M7 map. Yandex is never called: its script URL is answered with a stand-in that has the same small API
// surface (YMap, layers, YMapMarker with our own marker element, YMapFeature), so markers are real DOM.
const ownerPhone = '+998900000010', password = 'UI test only strong password 2026';
// The resident from tests/ui/m5.spec.ts, who set this password through the invite link.
const tenantPhone = '+998901777002', tenantPassword = 'Пароль жильца для UI';
const YMAPS_STUB = `
window.ymaps3 = {
  ready: Promise.resolve(),
  YMap: class { constructor(el){ this.el = el; el.dataset.map = 'ready'; } addChild(c){ if (c && c._el) this.el.appendChild(c._el); } removeChild(c){ if (c && c._el) c._el.remove(); } update(p){ this.el.dataset.location = JSON.stringify(p.location || {}); } destroy(){ this.el.innerHTML=''; } },
  YMapDefaultSchemeLayer: class {}, YMapDefaultFeaturesLayer: class {},
  // The real API places the marker element at its coordinates; the stand-in puts it in the middle.
  YMapMarker: class { constructor(p, el){ this._el = el; el.style.position = 'absolute'; el.style.left = '50%'; el.style.top = '50%'; this.update(p); } update(p){ if (p.coordinates) this._el.dataset.lnglat = p.coordinates.join(','); } },
  YMapFeature: class { constructor(p){ this._el = document.createElement('i'); this._el.className = 'stub-feature'; this._el.dataset.type = p.geometry.type; } update(){} },
};`;

async function stubYandex(page: Page, mode: 'ok' | 'fail' | 'nokey' = 'ok') {
  if (mode === 'nokey') await page.route('**/api/map/config', r => r.fulfill({ json: { provider: null, apiKey: null } }));
  else await page.route('**/api/map/config', r => r.fulfill({ json: { provider: 'yandex', apiKey: 'test-only' } }));
  await page.route('https://api-maps.yandex.ru/**', r => mode === 'fail' ? r.abort() : r.fulfill({ contentType: 'application/javascript', body: YMAPS_STUB }));
}
async function login(page: Page, phone = ownerPhone) {
  await page.goto('/login');
  await page.getByLabel('Телефон', { exact: true }).fill(phone);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/login'));
}
/** The resident's phone: tenant login with a bearer token, consent, then points. */
async function phone(request: APIRequestContext) {
  const h = { 'X-Ijara-Request': '1' };
  const token = (await (await request.post('/api/tenant/auth/login', { headers: h, data: { phone: tenantPhone, password: tenantPassword, platform: 'ANDROID', deviceName: 'UI phone' } })).json()).token as string;
  const auth = { ...h, Authorization: `Bearer ${token}` };
  expect((await request.post('/api/tenant/location/consent', { headers: auth, data: { enabled: true } })).status()).toBe(200);
  let seq = Date.now();
  return async (lat: number, lon: number, accuracyMeters = 14) => {
    const r = await request.post('/api/tenant/location', { headers: auth, data: { points: [{ latitude: lat, longitude: lon, accuracyMeters, recordedAt: new Date().toISOString(), sequence: seq++ }], state: { permission: 'ALWAYS', servicesEnabled: true, background: 'ALLOWED' } } });
    expect(r.status()).toBe(200);
  };
}

test('M7 map: a resident\'s point appears as a marker and moves in realtime without reloading the page', async ({ page, request }) => {
  test.setTimeout(90000);
  await stubYandex(page);
  const send = await phone(request);
  await send(41.311081, 69.240562);
  await login(page);
  await page.goto('/map');
  await expect(page.getByRole('heading', { name: 'Карта' })).toBeVisible();
  const marker = page.locator('.map-marker[aria-label$="сейчас здесь"]').first();
  await expect(marker).toHaveAttribute('data-lnglat', '69.240562,41.311081', { timeout: 15000 });
  await expect(page.getByRole('button', { name: /В сети \d+/ })).toBeVisible();
  // Mark this page instance: a reload would drop the flag.
  await page.evaluate(() => { (window as unknown as { __same: boolean }).__same = true; });
  await send(41.3125, 69.2421);
  await expect(marker).toHaveAttribute('data-lnglat', '69.2421,41.3125', { timeout: 10000 });
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true);
  // Click the marker: compact card with accuracy and actions.
  await marker.click();
  const card = page.getByRole('dialog', { name: /^Геолокация: / });
  await expect(card).toBeVisible();
  await expect(card.getByText('около 14 м')).toBeVisible();
  await expect(card.getByRole('link', { name: 'История' })).toBeVisible();
  await card.getByRole('link', { name: 'История' }).click();
  await expect(page.getByRole('heading', { name: /^История перемещений/ })).toBeVisible();
  await expect(page.getByText(/^\d+ точ/)).toBeVisible();
  await expect(page.locator('.stub-feature[data-type="LineString"]')).toHaveCount(1);
});

test('M7 map: search and status filters; list stays usable when the map does not load', async ({ page }) => {
  await stubYandex(page, 'fail');
  await login(page);
  await page.goto('/map');
  await expect(page.getByText('Не удалось загрузить карту.')).toBeVisible({ timeout: 25000 });
  await expect(page.getByText('Данные жильцов сохранены.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  const list = page.getByRole('complementary', { name: 'Жильцы на карте' });
  await expect(list.getByRole('button').first()).toBeVisible();
  await page.getByLabel('Поиск жильца').fill('нет-такого-жильца');
  await expect(list.getByText('Никого не нашли.')).toBeVisible();
  await page.getByLabel('Поиск жильца').fill('');
  await page.getByRole('button', { name: /^Отключена \d+$/ }).click();
  for (const item of await list.getByRole('button').all()) await expect(item).toHaveAccessibleName(/, Отключена$/);
});

test('M7 map without a Yandex key: says so plainly and still lists residents; works at 320–1440 px', async ({ page }) => {
  await stubYandex(page, 'nokey');
  await login(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/map');
    await expect(page.getByText('Карта не подключена')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Жильцы на карте' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}px`).toBe(true);
  }
  // Dashboard: a small summary that leads to the map.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Геолокация жильцов: открыть карту' })).toBeVisible();
});

test('M7 permission: staff without VIEW_LOCATION see no map in the menu and are refused by the server', async ({ page }) => {
  await stubYandex(page);
  // Admin from tests/ui/foundation.spec.ts, created without location rights.
  await login(page, '+998900000011');
  await expect(page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Карта' })).toHaveCount(0);
  await page.goto('/map');
  await expect(page.getByText('У вас нет доступа к геолокации жильцов.')).toBeVisible();
  const r = await page.request.get('/api/locations', { headers: { 'X-Ijara-Request': '1' } });
  expect(r.status()).toBe(403);
});
