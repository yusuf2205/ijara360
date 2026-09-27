import {test,expect,type Page} from '@playwright/test';
const password='UI test only strong password 2026';
const headers={Origin:'http://localhost:3000','X-Ijara-Request':'1'};
const day=(offset=0)=>{const value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(new Date(value+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);};
async function login(page:Page){await page.goto('/login');await page.getByLabel('Телефон',{exact:true}).fill('+998900000011');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Дом под контролем'})).toBeVisible();}
let residentId:string;
test.describe.configure({mode:'serial'});
test('M3 empty finance, create overdue charge on mobile and show financial denial',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page);
 const r=await page.request.post('/api/residents',{headers,data:{fullName:'M3 Finance UI',phone:'+998901239999'}});expect(r.status()).toBe(201);residentId=(await r.json()).id;
 await page.goto('/finance?residentId='+residentId);await expect(page.getByText('Начисления не найдены',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Создать начисление',exact:true}).click();const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Место начисления').selectOption({label:'Комната 1 / Место 1'});await dialog.getByLabel('Начало периода').fill(day(-10));await dialog.getByLabel('Конец периода').fill(day(10));await dialog.getByLabel('Оплатить до').fill(day(-1));await dialog.getByLabel('Сумма, сум').fill('1000.10');
 await dialog.getByRole('button',{name:'Подтвердить начисление'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByTestId('charge-row')).toContainText('Просрочено');await expect(page.getByText('Ограничен: просрочка',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.local/screenshots/m3-overdue-390.png',fullPage:true});
});
test('M3 partial then full payment restores access, ledger persists on reload at 320px',async({page})=>{
 await page.setViewportSize({width:320,height:740});await login(page);await page.goto('/finance?residentId='+residentId);
 await page.getByRole('button',{name:'Записать платёж',exact:true}).click();await page.getByLabel('Сумма, сум').fill('400.10');await page.getByLabel('Способ оплаты').selectOption('CARD_TRANSFER');await page.getByLabel('Комментарий',{exact:true}).fill('M3 UI partial');await page.getByRole('button',{name:'Подтвердить платёж'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
 await expect(page.getByTestId('charge-row')).toContainText('600 сум');await expect(page.getByText('Ограничен: просрочка',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Записать платёж',exact:true}).click();await page.getByRole('button',{name:'Подтвердить платёж'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByTestId('charge-row').getByText('Оплачено',{exact:true}).first()).toBeVisible();
 await page.reload();await expect(page.getByTestId('payment-row')).toHaveCount(2);await expect(page.getByText('Разрешён',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.local/screenshots/m3-paid-320.png',fullPage:true});
 await page.goto('/residents/'+residentId);await expect(page.getByText('Финансовый допуск разрешён',{exact:true})).toBeVisible();await page.getByRole('link',{name:'Начисления и платежи'}).click();await expect(page.getByRole('heading',{name:'Финансы',exact:true})).toBeVisible();
});
test('M3 lost response and reload retry keep exactly one payment',async({page})=>{
 await login(page);await page.goto('/finance?residentId='+residentId);await page.getByRole('button',{name:'Создать начисление'}).click();let dialog=page.getByRole('dialog');await dialog.getByLabel('Место начисления').selectOption({label:'Комната 1 / Место 1'});await dialog.getByLabel('Сумма, сум').fill('20');await dialog.getByRole('button',{name:'Подтвердить начисление'}).click();await expect(dialog).not.toBeVisible();
 await page.getByRole('button',{name:'Записать платёж',exact:true}).click();
 await page.route('**/api/finance/payments',async route=>{await route.fetch();await route.abort('failed');},{times:1});
 await page.getByRole('button',{name:'Подтвердить платёж'}).click();await expect(page.getByText('Запись ожидает подтверждения',{exact:true})).toBeVisible();await page.reload();await expect(page.getByText('Запись ожидает подтверждения',{exact:true})).toBeVisible();
 await page.route('**/api/finance/payments',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({message:'Войдите снова.'})}),{times:1});await page.getByRole('button',{name:'Проверить и повторить запись'}).click();await expect(page.getByRole('alert').filter({hasText:'Войдите снова.'})).toBeVisible();await expect(page.getByText('Запись ожидает подтверждения',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Проверить и повторить запись'}).click();await expect(page.getByText('Запись ожидает подтверждения',{exact:true})).not.toBeVisible();await expect(page.getByTestId('payment-row')).toHaveCount(3);
});
test('M3 filters, grace period and large desktop layout',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await login(page);await page.goto('/finance?residentId='+residentId);await page.getByRole('button',{name:'Создать начисление'}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Место начисления').selectOption({label:'Комната 1 / Место 1'});await dialog.getByLabel('Сумма, сум').fill('25.55');await dialog.getByLabel('Оплатить до').fill(day(-1));await dialog.getByLabel('Льготный период, дней').fill('2');await dialog.getByRole('button',{name:'Подтвердить начисление'}).click();await expect(dialog).not.toBeVisible();
 await expect(page.getByText('Разрешён: льготный период',{exact:true})).toBeVisible();await page.getByLabel('Статус начисления',{exact:true}).selectOption('OVERDUE');await expect(page.getByTestId('charge-row')).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'.local/screenshots/m3-desktop-1440.png',fullPage:true});
});
test('M3 resident receipt pays old debts, keeps advance and applies it to a new charge',async({page})=>{
 await login(page);await page.goto('/finance?residentId='+residentId);await page.getByRole('button',{name:'Принять оплату',exact:true}).click();
 let dialog=page.getByRole('dialog');await dialog.getByLabel('Сумма, сум').fill('100.55');await dialog.getByLabel('Способ оплаты').selectOption('BANK_TRANSFER');await dialog.getByRole('button',{name:'Подтвердить платёж'}).click();await expect(dialog).not.toBeVisible();
 await expect(page.getByTestId('payment-row')).toHaveCount(4);await expect(page.getByText('Остаток аванса: 75 сум',{exact:true})).toBeVisible();await expect(page.getByText('Разрешён',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Создать начисление'}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Место начисления').selectOption({label:'Комната 1 / Место 1'});await dialog.getByLabel('Сумма, сум').fill('50');await dialog.getByLabel('Тип начисления').selectOption('UTILITIES');await dialog.getByRole('button',{name:'Подтвердить начисление'}).click();await expect(dialog).not.toBeVisible();
 await page.reload();await expect(page.getByTestId('payment-row')).toHaveCount(4);await expect(page.getByText('Остаток аванса: 25 сум',{exact:true})).toBeVisible();await expect(page.getByTestId('charge-row').filter({hasText:'Коммунальные услуги'}).getByRole('button')).toHaveCount(0);await expect(page.getByTestId('payment-row').filter({hasText:'Банковский перевод'})).toContainText('Коммунальные услуги');
});
