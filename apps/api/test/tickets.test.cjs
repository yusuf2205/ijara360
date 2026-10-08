const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Tickets test only password 2026';
let app,server,owner,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Tickets',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

async function tenant(n){
 const phone='+99890300000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Секретный Автор '+n,phone}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 const token=(await request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID'}).expect(200)).body.token;
 return {resident:r,token};
}
async function staff(permissions,phone='+998900000002'){
 const u=(await send(owner,'post','/users').send({phone,fullName:'Staff '+phone.slice(-1),password}).expect(201)).body;
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions}).expect(200);
 const a=request.agent(server);await send(a,'post','/auth/login').send({phone,password}).expect(200);return a;
}
const complaint={category:'COMPLAINT',title:'Шум ночью',body:'Соседи шумят после полуночи.'};

test('a tenant files tickets and sees only their own, with staff shown as the administration',async()=>{
 const a=await tenant(1),b=await tenant(2);
 const t=(await bearer('post','/tenant/tickets',a.token).send(complaint).expect(201)).body;
 assert.equal(t.status,'OPEN');assert.equal(t.messages.length,1);assert.equal(t.messages[0].name,'Вы');
 assert.equal(t.residentId,undefined);assert.equal(t.roomId,undefined);
 await bearer('post','/tenant/tickets',a.token).send({...complaint,category:'OTHER'}).expect(422);
 await bearer('post','/tenant/tickets',a.token).send({...complaint,title:'  '}).expect(422);
 await bearer('get',`/tenant/tickets/${t.id}`,b.token).expect(404);
 await bearer('post',`/tenant/tickets/${t.id}/messages`,b.token).send({body:'чужое'}).expect(404);
 assert.equal((await bearer('get','/tenant/tickets',b.token).expect(200)).body.total,0);
 const reply=(await send(owner,'post',`/tickets/${t.id}/messages`).send({body:'Поговорим с соседями.'}).expect(201)).body;
 assert.equal(reply.status,'IN_PROGRESS','the first answer takes the ticket into work');
 const seen=(await bearer('get',`/tenant/tickets/${t.id}`,a.token).expect(200)).body;
 assert.deepEqual(seen.messages.map(m=>m.name),['Вы','Администрация']);assert.ok(!JSON.stringify(seen).includes('Owner'),'staff names stay internal');
 await bearer('post',`/tenant/tickets/${t.id}/messages`,a.token).send({body:'Спасибо'}).expect(201);
 const list=(await bearer('get','/tenant/tickets',a.token).expect(200)).body;assert.equal(list.items[0].messages,3);
});

test('only the owner sees the author; other staff get anonymised tickets and see the room only for repairs',async()=>{
 const a=await tenant(1);
 const c=(await bearer('post','/tenant/tickets',a.token).send(complaint).expect(201)).body;
 const r=(await bearer('post','/tenant/tickets',a.token).send({category:'REPAIR',title:'Течёт кран',body:'В ванной течёт кран.'}).expect(201)).body;
 const ownerView=(await send(owner,'get',`/tickets/${c.id}`).expect(200)).body;
 assert.equal(ownerView.author.fullName,'Секретный Автор 1');assert.equal(ownerView.room,'1');assert.equal(ownerView.thread[0].name,'Секретный Автор 1');
 const viewer=await staff(['TICKETS_VIEW']);
 const list=(await send(viewer,'get','/tickets').expect(200)).body;
 assert.equal(list.total,2);assert.ok(!JSON.stringify(list).includes('Секретный'),'no author name in the list');
 assert.ok(!JSON.stringify(list).includes(a.resident.id),'no resident id in the list');
 const anon=(await send(viewer,'get',`/tickets/${c.id}`).expect(200)).body;
 assert.equal(anon.author,null);assert.equal(anon.room,null);assert.equal(anon.thread[0].name,'Жилец');
 assert.ok(!JSON.stringify(anon).includes(a.resident.id)&&!JSON.stringify(anon).includes('Секретный'));
 assert.equal((await send(viewer,'get',`/tickets/${r.id}`).expect(200)).body.room,'1','repairs show where to go');
 const audit=await db.auditLog.findMany({where:{action:'TICKET_CREATED'}});
 assert.equal(audit.length,2);assert.ok(audit.every(x=>x.actorId===null&&!JSON.stringify(x.metadata).includes(a.resident.id)));
});

test('TICKETS_VIEW reads only; TICKETS_MANAGE answers and changes status with versions; others get 403',async()=>{
 const a=await tenant(1);
 const t=(await bearer('post','/tenant/tickets',a.token).send(complaint).expect(201)).body;
 const none=await staff([],'+998900000003'),viewer=await staff(['TICKETS_VIEW'],'+998900000004'),manager=await staff(['TICKETS_MANAGE'],'+998900000005');
 await send(none,'get','/tickets').expect(403);await send(none,'get',`/tickets/${t.id}`).expect(403);
 await send(viewer,'post',`/tickets/${t.id}/messages`).send({body:'x'}).expect(403);
 await send(viewer,'patch',`/tickets/${t.id}`).send({status:'RESOLVED',version:1}).expect(403);
 const m=(await send(manager,'get',`/tickets/${t.id}`).expect(200)).body;assert.equal(m.author,null,'managers are anonymised too');
 const done=(await send(manager,'patch',`/tickets/${t.id}`).send({status:'RESOLVED',version:m.version}).expect(200)).body;
 assert.equal(done.status,'RESOLVED');assert.ok(done.closedAt);
 await send(manager,'patch',`/tickets/${t.id}`).send({status:'OPEN',version:m.version}).expect(409);
 await send(manager,'post',`/tickets/${t.id}/messages`).send({body:'поздно'}).expect(409);
 await bearer('post',`/tenant/tickets/${t.id}/messages`,a.token).send({body:'ещё'}).expect(409);
 const reopened=(await send(manager,'patch',`/tickets/${t.id}`).send({status:'OPEN',version:done.version}).expect(200)).body;
 assert.equal(reopened.closedAt,null);
 assert.equal(await db.auditLog.count({where:{action:'TICKET_STATUS_CHANGED'}}),2);
 assert.equal((await send(manager,'get','/tickets?status=ACTIVE').expect(200)).body.total,1);
 await send(manager,'get','/tickets?status=BAD').expect(422);
});

test('tenant ticket routes reject staff sessions and closed accounts; open tickets are capped',async()=>{
 const a=await tenant(1);
 await send(owner,'get','/tenant/tickets').expect(401);
 await bearer('get','/tickets',a.token).expect(401);
 for(let i=0;i<10;i++)await bearer('post','/tenant/tickets',a.token).send({...complaint,title:'Тема '+i}).expect(201);
 await bearer('post','/tenant/tickets',a.token).send(complaint).expect(429);
 await db.$executeRawUnsafe('TRUNCATE rate_buckets');
 for(let i=0;i<10;i++)await bearer('post','/tenant/tickets',a.token).send({...complaint,title:'Ещё '+i}).expect(201);
 await db.$executeRawUnsafe('TRUNCATE rate_buckets');
 await bearer('post','/tenant/tickets',a.token).send(complaint).expect(409);
 await send(owner,'patch',`/residents/${a.resident.id}/app-account`).send({active:false}).expect(200);
 await bearer('get','/tenant/tickets',a.token).expect(401);
 assert.equal((await send(owner,'get','/tickets').expect(200)).body.total,20,'tickets stay after access is closed');
});
