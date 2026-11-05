const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {randomUUID}=require('node:crypto');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {NotificationsService}=require('../dist/notifications');
const {PhoneVerificationService}=require('../dist/phone-verification');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Parent access test password 2026';
let app,server,owner,beds,bot,sent=[],update=1;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const day=(offset)=>{const t=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(new Date(t+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);};
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();
 app.get(TelegramService).call=async(method,body)=>{sent.push({method,body});return true;};bot=app.get(PhoneVerificationService);});
beforeEach(async()=>{sent=[];await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Parents house',rooms:[{number:'1',capacity:4}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

/** A living resident with an activated app account (so the resident's own feed can be checked). */
async function resident(n){
 const phone='+99890400000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Resident '+n,phone}).expect(201)).body;
 const o=(await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:day(-40),monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201)).body;
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 return {resident:r,occupancy:o};
}
const addParent=(r,body={name:'Мама, Дилноза'})=>send(owner,'post',`/residents/${r.id}/guardians`).send(body);
const tokenOf=(link)=>new URL(link).searchParams.get('start');
const message=(tg,text)=>bot.handle({update_id:update++,message:{from:{id:tg},chat:{id:tg,type:'private'},text}});
const press=(tg,data)=>bot.handle({update_id:update++,callback_query:{id:'cb'+update,from:{id:tg},data,message:{chat:{id:tg},message_id:7}}});
const texts=(tg)=>sent.filter(s=>s.method==='sendMessage'&&String(s.body.chat_id)===String(tg)).map(s=>s.body.text);
const lastText=(tg)=>texts(tg).at(-1)||'';
const deliver=()=>app.get(NotificationsService).deliverDue();
const pay=(r,amount)=>send(owner,'post','/finance/payments').send({residentId:r.id,amount,method:'CASH',idempotencyKey:randomUUID()}).expect(201).then(x=>x.body);

test('staff add a parent, the parent connects in the bot, gets payments with the receipt and the balance, and leaves at check-out',async()=>{
 const {resident:r,occupancy:o}=await resident(1);
 const added=(await addParent(r,{name:'Мама, Дилноза',phone:'+998 90 111 22 33'}).expect(200)).body;
 assert.match(added.link,/^https:\/\/t\.me\/ijara_test_bot\?start=[A-Za-z0-9_-]{43}$/);
 let card=(await send(owner,'get',`/residents/${r.id}`).expect(200)).body;
 assert.equal(card.guardians.length,1);assert.equal(card.guardians[0].status,'PENDING');assert.equal(card.guardians[0].phone,'+998901112233');assert.ok(card.guardians[0].linkExpiresAt);

 await message(5001,`/start ${tokenOf(added.link)}`);
 assert.match(texts(5001)[0],/Вы подключены к сведениям о жильце Resident 1 \(Parents house\)/);
 assert.match(texts(5001)[0],/Местоположение и документы жильца вам не видны/);
 assert.match(lastText(5001),/Долг: 0/);
 card=(await send(owner,'get',`/residents/${r.id}`).expect(200)).body;
 assert.equal(card.guardians[0].status,'LINKED');assert.equal(card.guardians[0].linkExpiresAt,null);
 const told=await db.notification.findFirst({where:{kind:'GUARDIAN_LINKED'}});
 assert.ok(told.tenantAccountId,'the resident is told in their app');assert.match(told.body,/Мама, Дилноза/);
 assert.ok(await db.auditLog.findFirst({where:{action:'GUARDIAN_LINKED',entityId:r.id}}));

 // The same link does not work twice.
 sent=[];await message(5002,`/start ${tokenOf(added.link)}`);assert.match(lastText(5002),/Ссылка недействительна/);

 // A charge and a payment reach the parent, in the third person and with the receipt number.
 await send(owner,'post','/finance/charges').send({residentId:r.id,bedId:beds[1].id,amount:'500000',type:'RENT',billingPeriodStart:day(-40),billingPeriodEnd:day(-10),dueDate:day(-5),gracePeriodDays:0,idempotencyKey:randomUUID()}).expect(201);
 await pay(r,'200000');
 const forParent=await db.notification.findMany({where:{guardianId:{not:null}},orderBy:{createdAt:'asc'}});
 assert.deepEqual(forParent.map(n=>n.kind),['CHARGE_CREATED','PAYMENT_RECORDED']);
 assert.match(forParent[1].body,/^Resident 1: получено 200 000 сум\. Чек № 000001\.$/);
 sent=[];await deliver();
 const delivered=sent.filter(s=>s.body.chat_id==='5001');
 assert.equal(delivered.length,2);
 assert.deepEqual(delivered[1].body.reply_markup.inline_keyboard[0][0].callback_data,`gb:${card.guardians[0].id}`);

 // The balance button and the language switch.
 const gid=card.guardians[0].id;
 sent=[];await press(5001,`gb:${gid}`);
 assert.match(lastText(5001),/Долг: 300 000 сум \(просрочено: 300 000 сум\)/);
 assert.match(lastText(5001),/Последняя оплата: 200 000 сум, .*чек № 000001/);
 sent=[];await press(5001,`gl:${gid}`);assert.match(lastText(5001),/Qarz: 300 000 so‘m/);
 await pay(r,'300000');
 assert.match((await db.notification.findFirst({where:{guardianId:gid,kind:'PAYMENT_RECORDED'},orderBy:{createdAt:'desc'}})).body,/qabul qilindi\. Chek № 000002\./);

 // Someone else's Telegram cannot read this parent's balance.
 sent=[];await press(6666,`gb:${gid}`);assert.equal(texts(6666).length,0);
 assert.match(sent.find(s=>s.method==='answerCallbackQuery').body.text,/^Вы больше не подключены к этому жильцу\. \/ Siz endi/);

 // A plain /start shows the balance instead of the application link.
 sent=[];await message(5001,'/start');assert.match(lastText(5001),/Resident 1/);

 // Check-out: a last message, then access ends and contact data is cleared.
 await send(owner,'post',`/occupancies/${o.id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 const bye=await db.notification.findFirst({where:{guardianId:gid,kind:'OCCUPANCY_CHECKED_OUT'}});assert.match(bye.body,/yashash .* tugadi/);
 const g=await db.guardian.findUnique({where:{id:gid}});
 assert.ok(g.revokedAt);assert.equal(g.telegramUserId,null);assert.equal(g.phone,null);
 card=(await send(owner,'get',`/residents/${r.id}`).expect(200)).body;assert.equal(card.guardians.length,0);
 sent=[];await press(5001,`gb:${gid}`);assert.equal(texts(5001).length,0,'no balance after check-out');
});

test('rules: living residents only, at most three parents, one Telegram once, staff disconnect, the parent leaves',async()=>{
 const {resident:r,occupancy:o}=await resident(1);
 const {resident:r2,occupancy:o2}=await resident(2);
 await send(owner,'post',`/occupancies/${o2.id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 assert.match((await addParent(r2).expect(409)).body.message,/только к жильцу, который сейчас проживает/);
 await addParent(r,{name:'X'}).expect(422);

 const a=(await addParent(r,{name:'Мама'}).expect(200)).body,b=(await addParent(r,{name:'Папа'}).expect(200)).body;
 await addParent(r,{name:'Бабушка'}).expect(200);
 assert.match((await addParent(r,{name:'Дядя'}).expect(409)).body.message,/не больше 3/);

 // The same Telegram opening a second parent's link stays connected once.
 await message(7001,`/start ${tokenOf(a.link)}`);
 sent=[];await message(7001,`/start ${tokenOf(b.link)}`);assert.match(texts(7001)[0],/уже получаете сведения/);
 let card=(await send(owner,'get',`/residents/${r.id}`).expect(200)).body;
 assert.deepEqual(card.guardians.map(g=>g.name),['Мама','Бабушка']);

 // A new link replaces the old one; an expired link is refused.
 const grandma=card.guardians[1];
 const fresh=(await send(owner,'post',`/residents/${r.id}/guardians/${grandma.id}/link`).expect(200)).body;
 assert.notEqual(fresh.link,'');
 await db.guardianInvite.updateMany({where:{guardianId:grandma.id,consumedAt:null},data:{expiresAt:new Date(Date.now()-1000)}});
 sent=[];await message(7003,`/start ${tokenOf(fresh.link)}`);assert.match(lastText(7003),/Ссылка недействительна/);

 // Transfer and a new end date reach the connected parent.
 await send(owner,'post',`/occupancies/${o.id}/transfer`).send({bedId:beds[3].id,transferDate:day(0)}).expect(201);
 assert.match((await db.notification.findFirst({where:{kind:'OCCUPANCY_TRANSFERRED'}})).body,/^Resident 1: новое место — комната 1, место 4\.$/);

 // Staff disconnect: the parent is told, and the button stops working.
 sent=[];await send(owner,'delete',`/residents/${r.id}/guardians/${card.guardians[0].id}`).expect(200);
 assert.match(lastText(7001),/Администрация отключила вас/);
 sent=[];await press(7001,`gb:${card.guardians[0].id}`);assert.equal(texts(7001).length,0);
 assert.ok(await db.auditLog.findFirst({where:{action:'GUARDIAN_REVOKED',metadata:{path:['reason'],equals:'STAFF'}}}));

 // The parent can leave on their own.
 const again=(await send(owner,'post',`/residents/${r.id}/guardians/${grandma.id}/link`).expect(200)).body;
 await message(7004,`/start ${tokenOf(again.link)}`);
 sent=[];await press(7004,`gq:${grandma.id}`);assert.match(lastText(7004),/Отключиться от сведений/);
 await press(7004,`gqy:${grandma.id}`);
 assert.ok((await db.guardian.findUnique({where:{id:grandma.id}})).revokedAt);
 card=(await send(owner,'get',`/residents/${r.id}`).expect(200)).body;assert.equal(card.guardians.length,0);
 // A parent who is not connected gets the usual application link on /start.
 sent=[];await message(7004,'/start');assert.match(lastText(7004),/Подайте заявку/);
});
