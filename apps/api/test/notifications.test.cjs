const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {randomUUID}=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService,TelegramError}=require('../dist/telegram');
const {NotificationsService}=require('../dist/notifications');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Notifications test password 2026';
let app,server,owner,beds,service,sent,fail;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();service=app.get(NotificationsService);
 app.get(TelegramService).call=async(method,body)=>{if(fail)throw fail();sent.push({method,body});return true;};});
beforeEach(async()=>{sent=[];fail=null;await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Notify',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

async function tenant(n,{telegram=true}={}){
 const phone='+99890400000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Жилец '+n,phone}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 if(telegram)await db.tenantAccount.update({where:{residentId:r.id},data:{telegramUserId:String(7000+n)}});
 const token=(await request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID'}).expect(200)).body.token;
 return {resident:r,token};
}
const charge=(r,n,extra={})=>send(owner,'post','/finance/charges').send({residentId:r.id,bedId:beds[n].id,amount:'1200000',type:'RENT',billingPeriodStart:'2026-11-01',billingPeriodEnd:'2026-11-30',dueDate:'2026-11-05',gracePeriodDays:0,idempotencyKey:randomUUID(),...extra}).expect(201).then(x=>x.body);
const feed=t=>bearer('get','/tenant/notifications',t).expect(200).then(r=>r.body);

test('a charge and a payment reach the tenant feed and Telegram after commit',async()=>{
 const a=await tenant(1);
 const c=await charge(a.resident,1);
 let f=await feed(a.token);
 assert.equal(f.unread,1);assert.equal(f.items[0].title,'Новое начисление');assert.match(f.items[0].body,/Аренда за ноябрь: 1 200 000 сум, оплатить до 5 ноября\./);
 assert.equal(sent.length,0,'nothing is sent inside the request');
 assert.equal(await service.deliverDue(),1);
 assert.equal(sent[0].body.chat_id,'7001');assert.match(sent[0].body.text,/^Новое начисление\nАренда за ноябрь/);
 assert.equal((await db.notificationDelivery.findFirst()).status,'SENT');
 await send(owner,'post','/finance/payments').send({residentId:a.resident.id,chargeId:c.id,amount:'1400000',method:'CASH',idempotencyKey:randomUUID()}).expect(201);
 f=await feed(a.token);
 assert.equal(f.items[0].title,'Оплата зачтена');assert.equal(f.items[0].body,'Получено 1 400 000 сум. 200 000 сум ушло в аванс.');
 await service.deliverDue();assert.equal(sent.length,2);
 assert.equal(await service.deliverDue(),0,'sent deliveries are not sent twice');
});

test('Telegram failures retry with backoff; a blocked chat stops at once; six failures give up',async()=>{
 const a=await tenant(1);
 await charge(a.resident,1);
 fail=()=>new TelegramError(false);
 await service.deliverDue();
 let d=await db.notificationDelivery.findFirst();
 assert.deepEqual({status:d.status,attempts:d.attempts,lastError:d.lastError},{status:'PENDING',attempts:1,lastError:'TELEGRAM_UNAVAILABLE'});
 assert.ok(d.nextAttemptAt>new Date(Date.now()+20000),'next try is backed off');
 assert.equal(await service.deliverDue(),0,'not due yet');
 fail=null;await db.notificationDelivery.updateMany({data:{nextAttemptAt:new Date(Date.now()-1000)}});
 await service.deliverDue();d=await db.notificationDelivery.findFirst();assert.equal(d.status,'SENT');assert.equal(d.attempts,2);
 await charge(a.resident,1,{billingPeriodStart:'2026-12-01',billingPeriodEnd:'2026-12-31',dueDate:'2026-12-05'});
 fail=()=>new TelegramError(true);await service.deliverDue();
 d=await db.notificationDelivery.findFirst({where:{status:{not:'SENT'}}});
 assert.deepEqual({status:d.status,lastError:d.lastError},{status:'FAILED',lastError:'CHAT_UNAVAILABLE'});
 await charge(a.resident,1,{billingPeriodStart:'2027-01-01',billingPeriodEnd:'2027-01-31',dueDate:'2027-01-05'});
 fail=()=>new TelegramError(false);
 for(let i=0;i<6;i++){await db.notificationDelivery.updateMany({where:{status:'PENDING'},data:{nextAttemptAt:new Date(Date.now()-1000)}});await service.deliverDue();}
 d=await db.notificationDelivery.findFirst({where:{lastError:'TELEGRAM_UNAVAILABLE'}});
 assert.deepEqual({status:d.status,attempts:d.attempts},{status:'FAILED',attempts:6});
 assert.equal((await feed(a.token)).total,3,'the feed keeps every notification regardless of Telegram');
});

test('a rolled-back action leaves no notification or outbox row; no account or no Telegram means no delivery',async()=>{
 const a=await tenant(1);
 await assert.rejects(db.$transaction(async tx=>{await service.tenant(tx,a.resident.id,{kind:'TEST',title:'x',body:'y'});throw Error('rollback');}));
 assert.equal(await db.notification.count(),0);assert.equal(await db.notificationDelivery.count(),0);
 const b=await tenant(2,{telegram:false});
 await charge(b.resident,2);
 assert.equal((await feed(b.token)).total,1);assert.equal(await db.notificationDelivery.count(),0,'no Telegram link, feed only');
 const plain=(await send(owner,'post','/residents').send({fullName:'Без приложения',phone:'+998904000009'}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:plain.id,bedId:beds[0].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 await charge(plain,0);
 assert.equal(await db.notification.count(),1,'no app account, no notification');
});

test('tickets notify staff without the author and answers notify the tenant; feeds are private',async()=>{
 const a=await tenant(1);
 const viewer=await (async()=>{const u=(await send(owner,'post','/users').send({phone:'+998900000002',fullName:'Viewer',password}).expect(201)).body;await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:['TICKETS_VIEW']}).expect(200);const s=request.agent(server);await send(s,'post','/auth/login').send({phone:'+998900000002',password}).expect(200);return s;})();
 const other=await (async()=>{const u=(await send(owner,'post','/users').send({phone:'+998900000003',fullName:'Other',password}).expect(201)).body;await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:['FINANCE_VIEW']}).expect(200);const s=request.agent(server);await send(s,'post','/auth/login').send({phone:'+998900000003',password}).expect(200);return s;})();
 const t=(await bearer('post','/tenant/tickets',a.token).send({category:'REPAIR',title:'Течёт кран',body:'В ванной течёт кран.'}).expect(201)).body;
 const ownerFeed=(await send(owner,'get','/notifications').expect(200)).body;
 assert.equal(ownerFeed.items[0].title,'Новое обращение');assert.equal(ownerFeed.items[0].body,'Поломка: «Течёт кран»');assert.equal(ownerFeed.items[0].link,`/tickets/${t.id}`);
 const viewerFeed=(await send(viewer,'get','/notifications').expect(200)).body;
 assert.equal(viewerFeed.unread,1);assert.ok(!JSON.stringify(viewerFeed).includes('Жилец 1'),'no author in staff notifications');
 assert.equal((await send(other,'get','/notifications').expect(200)).body.total,0,'no ticket rights, no ticket notifications');
 await send(owner,'post',`/tickets/${t.id}/messages`).send({body:'Сантехник придёт завтра.'}).expect(201);
 let f=await feed(a.token);
 assert.equal(f.items[0].title,'Ответ на обращение');assert.equal(f.items[0].body,'«Течёт кран»: Сантехник придёт завтра.');
 const v=(await send(owner,'get',`/tickets/${t.id}`).expect(200)).body;
 await send(owner,'patch',`/tickets/${t.id}`).send({status:'RESOLVED',version:v.version}).expect(200);
 f=await feed(a.token);assert.equal(f.items[0].title,'Обращение решено');assert.equal(f.unread,2);
 // Reading: own items only, by id or all at once.
 assert.equal((await bearer('post','/tenant/notifications/read',a.token).send({ids:[ownerFeed.items[0].id]}).expect(200)).body.read,0,'cannot mark staff items');
 assert.equal((await bearer('post','/tenant/notifications/read',a.token).send({ids:[f.items[0].id]}).expect(200)).body.read,1);
 assert.equal((await feed(a.token)).unread,1);
 await bearer('post','/tenant/notifications/read',a.token).send({}).expect(200);assert.equal((await feed(a.token)).unread,0);
 await send(owner,'post','/notifications/read').send({}).expect(200);assert.equal((await send(owner,'get','/notifications').expect(200)).body.unread,0);
 assert.equal((await send(viewer,'get','/notifications').expect(200)).body.unread,1,'one person reading does not read for others');
 await bearer('get','/notifications',a.token).expect(401);await send(owner,'get','/tenant/notifications').expect(401);
 await bearer('post','/tenant/notifications/read',a.token).send({ids:['not-a-uuid']}).expect(422);
});
