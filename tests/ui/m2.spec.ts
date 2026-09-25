import {test,expect,type Page,type BrowserContext} from '@playwright/test';
const password='UI test only strong password 2026';
const person='М2 Тестовый жилец';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function selectRoom(page:Page,number:string){const select=page.getByRole('combobox',{name:'Комната',exact:true});const value=await select.locator('option').filter({hasText:new RegExp('^Комната '+number+' ')}).getAttribute('value');await select.selectOption(value!);}
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
async function login(page:Page,phone='+998900000010') {
 if(phone==='+998900000010' && ownerCookies.length){await page.context().addCookies(ownerCookies);await page.goto('/');await expect(page.getByRole('heading',{name:'Дом под контролем'})).toBeVisible();return;}
 await page.goto('/login');await page.getByLabel('Телефон',{exact:true}).fill(phone);await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Дом под контролем'})).toBeVisible();if(phone==='+998900000010')ownerCookies=await page.context().cookies();
}
async function next(page:Page){await page.getByRole('dialog').getByRole('button',{name:'Продолжить',exact:true}).click();}
async function resident(page:Page){await page.goto('/residents');await page.getByRole('link').filter({hasText:person}).click();await expect(page.getByRole('heading',{name:person,exact:true})).toBeVisible();}
async function conditions(page:Page){await page.getByLabel('Месячная цена, сум',{exact:true}).fill('750000.50');await page.getByLabel('Депозит, сум',{exact:true}).fill('100000');await next(page);}
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
test.describe.configure({mode:'serial'});
test('M2 mobile check-in from a free bed shows real resident and counters after reload',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page);await page.getByRole('heading',{name:'Комната №1',exact:true}).click();
 await page.locator('.bed-card').first().getByRole('button',{name:'Заселить',exact:true}).click();
 await page.getByLabel('ФИО',{exact:true}).fill(person);await page.getByLabel('Телефон',{exact:true}).fill('+998901234501');await page.getByRole('textbox',{name:'Заметка',exact:true}).fill('Заметка М2');await next(page);await next(page);await conditions(page);
 await page.screenshot({path:'.local/screenshots/m2-checkin-390.png',fullPage:true});await noOverflow(page);
 await page.getByRole('button',{name:'Подтвердить заселение'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('.bed-card').first()).toContainText(person);
 await page.reload();await expect(page.locator('.bed-card').first()).toContainText('Занято');await expect(page.locator('.room-summary')).toContainText('1 занято');
 await page.goto('/');await expect(page.locator('.stat').filter({hasText:'Жильцов сейчас'}).locator('strong')).toHaveText('1');
});
test('M2 transfer to another room preserves both stays and prices',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await login(page);await resident(page);await page.getByRole('button',{name:'Переселить',exact:true}).click();
 await selectRoom(page,'2');await page.getByRole('combobox',{name:'Свободное место',exact:true}).selectOption({label:'Место 1'});await page.getByRole('button',{name:'Подтвердить переселение'}).click();
 await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.locator('.resident-location')).toContainText('Комната 2 / Место 1');await expect(page.locator('.stay-row')).toHaveCount(2);await expect(page.locator('.stay-row').filter({hasText:'Завершено'})).toContainText('Комната 1 / Место 1');
 await page.screenshot({path:'.local/screenshots/m2-resident-1440.png',fullPage:true});await noOverflow(page);
});
test('M2 checkout at 320px frees bed and keeps resident/history',async({page})=>{
 await page.setViewportSize({width:320,height:740});await login(page);await resident(page);await page.getByRole('button',{name:'Выселить',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('Депозит');await noOverflow(page);await page.getByRole('button',{name:'Подтвердить выселение'}).click();await expect(page.getByRole('button',{name:'Заселить снова'})).toBeVisible();await expect(page.locator('.stay-row')).toHaveCount(2);
 await page.screenshot({path:'.local/screenshots/m2-history-320.png',fullPage:true});await noOverflow(page);
 await page.goto('/rooms');await page.getByRole('heading',{name:'Комната №2',exact:true}).click();await expect(page.locator('.bed-card').first()).toContainText('Свободно');
 await page.goto('/residents');await page.getByRole('button',{name:'Выселенные',exact:true}).click();await expect(page.locator('.resident-row')).toHaveCount(1);
});
test('M2 stale free-bed dialog reports friendly conflict without losing inputs',async({page})=>{
 await login(page);await page.getByRole('heading',{name:'Комната №1',exact:true}).click();
 await page.locator('.bed-card').first().getByRole('button',{name:'Заселить',exact:true}).click();await page.getByLabel('ФИО',{exact:true}).fill('Конкурент А');await page.getByLabel('Телефон',{exact:true}).fill('+998901234502');await next(page);
 const bedId=await page.getByRole('combobox',{name:'Свободное место',exact:true}).inputValue();await next(page);await conditions(page);
 const origin='http://localhost:3000';const headers={Origin:origin,'X-Ijara-Request':'1'};
 const result=await page.request.post('/api/occupancies/check-in',{headers,data:{resident:{fullName:'Конкурент Б',phone:'+998901234503'},bedId,moveInDate:today,monthlyPrice:'500000',paymentDay:1,depositAmount:'0'}});expect(result.status()).toBe(201);const o=await result.json();
 await page.getByRole('button',{name:'Подтвердить заселение'}).click();await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Это место уже занято');await expect(page.getByRole('dialog')).toContainText('Конкурент А');
 await page.getByRole('button',{name:'Закрыть',exact:true}).click();const out=await page.request.post(`/api/occupancies/${o.id}/check-out`,{headers,data:{moveOutDate:today}});expect(out.status()).toBe(201);
 const people=await(await page.request.get('/api/residents')).json();expect(people.some((r:{phone:string})=>r.phone==='+998901234502')).toBe(false);
});
test('M2 duplicate phone suggests existing resident; returning resident is reused',async({page})=>{
 await login(page);await page.goto('/residents');await page.getByRole('button',{name:'Заселить',exact:true}).click();await page.getByLabel('ФИО',{exact:true}).fill('Повтор');await page.getByLabel('Телефон',{exact:true}).fill('+998901234501');await expect(page.getByRole('button',{name:'Выбрать существующего жильца'})).toBeVisible();await page.getByRole('button',{name:'Выбрать существующего жильца'}).click();await expect(page.getByLabel('ФИО',{exact:true})).toHaveValue(person);await next(page);
 await selectRoom(page,'1');await page.getByRole('combobox',{name:'Свободное место',exact:true}).selectOption({label:'Место 2'});await next(page);await conditions(page);await page.getByRole('button',{name:'Подтвердить заселение'}).click();await expect(page.getByRole('heading',{name:person,exact:true})).toBeVisible();await expect(page.locator('.stay-row')).toHaveCount(3);
 const people=await(await page.request.get('/api/residents')).json();expect(people.filter((r:{phone:string})=>r.phone==='+998901234501')).toHaveLength(1);
});
test('M2 ADMIN can edit, transfer and check out resident; list search works on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page,'+998900000011');await resident(page);await page.getByRole('button',{name:'Изменить данные'}).click();await page.getByRole('textbox',{name:'Заметка',exact:true}).fill('Обновлено управляющим');await page.getByRole('dialog').getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.locator('.resident-note')).toHaveText('Обновлено управляющим');
 await page.getByRole('button',{name:'Переселить',exact:true}).click();await selectRoom(page,'2');await page.getByRole('combobox',{name:'Свободное место',exact:true}).selectOption({label:'Место 2'});await page.getByRole('button',{name:'Подтвердить переселение'}).click();await expect(page.locator('.resident-location')).toContainText('Комната 2 / Место 2');
 await page.getByRole('button',{name:'Выселить',exact:true}).click();await page.getByRole('button',{name:'Подтвердить выселение'}).click();await expect(page.getByRole('button',{name:'Заселить снова'})).toBeVisible();await expect(page.locator('.stay-row')).toHaveCount(4);
 await page.goto('/residents');await page.getByLabel('Найти жильца').fill('901234501');await expect(page.locator('.resident-row')).toHaveCount(1);await noOverflow(page);await page.screenshot({path:'.local/screenshots/m2-residents-390.png',fullPage:true});
 await page.goto('/history');await expect(page.locator('.activity-list')).toContainText('Жилец выселен');
});
