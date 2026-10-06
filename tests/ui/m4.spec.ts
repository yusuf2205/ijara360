import {test,expect,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
const origin=process.env.TEST_WEB_ORIGIN||'http://localhost:3000';
const headers={Origin:origin,'X-Ijara-Request':'1'};
const tashkentToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function login(page:Page,phone='+998900000010'){await page.goto('/login');await page.getByLabel('Телефон',{exact:true}).fill(phone);await page.getByLabel('Пароль',{exact:true}).fill('UI test only strong password 2026');await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.getByRole('heading',{name:'Дом под контролем'})).toBeVisible();}
function contact(token:string,phone:string){if(origin!=='http://100.126.164.29:3187')throw Error('NAS test gateway required for Telegram adapter');execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','100.126.164.29','docker','exec','ijara360-m3-test-api','node','--env-file=/run/api.env','scripts/test-telegram-contact.cjs',token,phone],{stdio:'pipe',timeout:30000});}
async function own(page:Page){return (await page.request.get('/api/public/applications/me')).json();}
async function apiDraft(page:Page,phone:string,pinfl:string){
  await page.request.post('/api/public/applications',{headers,data:{phone,channel:'WEB'}});
  const link=await (await page.request.post('/api/public/applications/phone',{headers})).json();contact(new URL(link.url).searchParams.get('start')!,phone);
  const a=await own(page);await page.request.patch('/api/public/applications/me',{headers,data:{version:a.version,fullName:`Applicant ${phone.slice(-2)}`,dateOfBirth:'2000-01-01',pinfl,passportSeries:'AB',passportNumber:phone.slice(-7),occupationType:'OTHER',requestedMoveInDate:'2026-10-01',plannedDuration:'6 months',emergencyName:'Test Contact',emergencyRelationship:'Parent',emergencyPhone:'+998900000099',consent:true}});
  const buffer=await sharp(randomBytes(640*640*3),{raw:{width:640,height:640,channels:3}}).png().toBuffer();
  for(const kind of ['PASSPORT_FRONT','PASSPORT_BACK','FACE'])expect((await page.request.put(`/api/public/applications/documents/${kind}`,{headers:{...headers,'Content-Type':'image/png'},data:buffer})).ok()).toBe(true);
  expect((await page.request.post('/api/public/applications/submit',{headers,data:{version:(await own(page)).version}})).ok()).toBe(true);return own(page);
}
test('M4 public wizard resumes, uploads previews and submits; staff sees realtime then approves and converts',async({page,browser})=>{
  test.setTimeout(120000);await login(page);await page.goto('/applications');await expect(page.getByText('Изменения поступают автоматически')).toBeVisible();
  const context=await browser.newContext({baseURL:origin,viewport:{width:390,height:844}});const applicant=await context.newPage();
  await applicant.goto('/apply');await applicant.getByLabel('Ваш телефон').fill('+998900000066');await applicant.getByRole('button',{name:'Начать анкету'}).click();
  await expect(applicant.getByRole('heading',{name:'Телефон',exact:true})).toBeVisible();
  await applicant.getByRole('button',{name:'Подтвердить через Telegram'}).click();const url=await applicant.getByRole('link',{name:'Открыть бота и передать свой контакт'}).getAttribute('href');contact(new URL(url!).searchParams.get('start')!,'+998900000066');
  await expect(applicant.getByText('Телефон подтверждён',{exact:true})).toBeVisible();await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  await applicant.getByLabel('ФИО',{exact:true}).fill('M4 UI Applicant');await applicant.getByLabel('Дата рождения',{exact:true}).fill('2000-01-01');
  await expect(applicant.getByRole('status')).toHaveText('Черновик сохранён на сервере');await applicant.reload();await expect(applicant.getByLabel('ФИО',{exact:true})).toHaveValue('M4 UI Applicant');
  await applicant.getByLabel('ПИНФЛ — 14 цифр').fill('11112222333344');await applicant.getByLabel('Серия паспорта — 2 латинские буквы').fill('AA');await applicant.getByLabel('Номер паспорта — 7 цифр').fill('7654321');await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  await applicant.getByLabel('Занятость').selectOption('STUDENT');await applicant.getByLabel('Университет / институт').fill('Test Institute');await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  await applicant.getByLabel('Желаемая дата заселения').fill('2026-10-01');await applicant.getByLabel('Планируемый срок проживания').fill('12 months');await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  await applicant.getByLabel('ФИО контактного лица').fill('Test Contact');await applicant.getByLabel('Кем приходится').fill('Parent');await applicant.getByLabel('Телефон контактного лица').fill('+998900000099');await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  const file={name:'test-image.png',mimeType:'image/png',buffer:await sharp(randomBytes(640*640*3),{raw:{width:640,height:640,channels:3}}).png().toBuffer()};
  for(const label of ['Передняя сторона паспорта','Обратная сторона паспорта']){await applicant.getByLabel(label,{exact:true}).setInputFiles(file);await expect(applicant.getByAltText(label,{exact:true})).toBeVisible();}
  await applicant.getByRole('button',{name:'Далее',exact:true}).click();await applicant.getByLabel('Фотография лица',{exact:true}).setInputFiles(file);await expect(applicant.getByAltText('Фотография лица',{exact:true})).toBeVisible();await applicant.getByRole('button',{name:'Далее',exact:true}).click();
  await applicant.getByRole('checkbox').check();await applicant.getByRole('button',{name:'Отправить заявку'}).click();await expect(applicant.getByText('Заявка принята',{exact:true})).toBeVisible();
  await expect(page.getByText('M4 UI Applicant',{exact:true})).toBeVisible();await page.getByText('M4 UI Applicant',{exact:true}).click();await page.getByRole('button',{name:'Начать рассмотрение'}).click();
  await page.getByRole('button',{name:'Фото лица',exact:true}).click();await expect(page.getByAltText('Документ заявки')).toBeVisible();await page.getByRole('checkbox',{name:/Я вручную проверил/}).check();await page.getByRole('button',{name:'Одобрить',exact:true}).click();
  await expect(applicant.getByText('Одобрено',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Заселить одобренного арендатора'}).click();
  await page.getByLabel('Свободное место').selectOption({index:1});await page.getByLabel('Дата заселения',{exact:true}).fill(tashkentToday());await page.getByLabel('Аренда за месяц, сум').fill('500000');await page.getByRole('button',{name:'Подтвердить заселение'}).click();await expect(page).toHaveURL(/\/residents\/[a-f0-9-]+$/);
  await expect(page.getByRole('heading',{name:'M4 UI Applicant',exact:true})).toBeVisible();await context.close();
});
test('M4 needs-info and rejection appear on applicant status without reload',async({page,browser})=>{
  test.setTimeout(90000);await login(page);const context=await browser.newContext({baseURL:origin});const applicant=await context.newPage();const a=await apiDraft(applicant,'+998900000067','11112222333345');await applicant.goto('/apply');await page.goto(`/applications/${a.id}`);await page.getByRole('button',{name:'Начать рассмотрение'}).click();
  await page.getByLabel('Комментарий / причина').fill('Проверьте срок');await page.getByLabel('Какие данные нужны').fill('Планируемый срок');await page.getByRole('button',{name:'Запросить данные'}).click();await expect(applicant.getByText('Нужна дополнительная информация',{exact:true})).toBeVisible();
  const current=await own(applicant);await applicant.request.post('/api/public/applications/submit',{headers,data:{version:current.version}});await expect(page.getByRole('button',{name:'Начать рассмотрение'})).toBeVisible();await page.getByRole('button',{name:'Начать рассмотрение'}).click();await page.getByLabel('Комментарий / причина').fill('Нет подходящих мест');await page.getByRole('button',{name:'Отклонить',exact:true}).click();await applicant.reload();await expect(applicant.getByText('Отклонено',{exact:true})).toBeVisible();await expect(applicant.getByText('Нет подходящих мест',{exact:true})).toBeVisible();await context.close();
});
test('M4 permission management grants list only and protects documents from direct URLs',async({page,browser})=>{
  await login(page);await page.goto('/settings');const form=page.locator('form').filter({has:page.getByRole('heading',{name:'Тестовый управляющий',exact:true})});await form.getByLabel('Просмотр заявок',{exact:true}).check();await form.getByRole('button',{name:'Сохранить права'}).click();
  const context=await browser.newContext({baseURL:origin});const admin=await context.newPage();await login(admin,'+998900000011');await admin.goto('/applications?status=CONVERTED_TO_RESIDENT');await admin.getByText('M4 UI Applicant',{exact:true}).click();await expect(admin.getByText('11112222333344',{exact:true})).toHaveCount(0);await expect(admin.getByRole('button',{name:'Фото лица',exact:true})).toHaveCount(0);const id=admin.url().split('/').pop();expect((await admin.request.get(`/api/applications/${id}/documents/FACE`)).status()).toBe(403);await context.close();
});
for(const width of [320,390,768,1440])test(`M4 public layout ${width}px`,async({page})=>{await page.setViewportSize({width,height:900});await page.goto('/apply');await expect(page.getByRole('heading',{name:'Заявка на проживание'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`.local/screenshots/m4-apply-${width}.png`,fullPage:true});});
