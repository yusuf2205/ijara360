const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {randomUUID}=require('node:crypto');
const {WebSocket}=require('ws');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Realtime test only password 2026';
let app,server,owner,ownerCookie,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Opens a socket and collects every event after 'ready'; rejects when the server refuses the upgrade. */
function open(path,headers){
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`,{headers});const events=[];
  return new Promise((resolve,reject)=>{ws.once('error',reject);ws.once('message',()=>{ws.on('message',raw=>events.push(JSON.parse(raw)));resolve({ws,events});});});
}
const until=async(events,pred,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(events.some(pred))return true;await sleep(50);}return false;};
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Realtime',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);const login=await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);ownerCookie=login.headers['set-cookie'][0].split(';')[0];
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

async function staffWith(permissions,phone){
 const u=(await send(owner,'post','/users').send({phone,fullName:'Staff',password}).expect(201)).body;
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions}).expect(200);
 const r=await send(request(server),'post','/auth/login').send({phone,password}).expect(200);
 return {user:u,cookie:r.headers['set-cookie'][0].split(';')[0]};
}
async function tenant(n){
 const phone='+99890500000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Жилец '+n,phone}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 const token=(await request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID'}).expect(200)).body.token;
 return {resident:r,token,phone};
}
const charge=(r,n)=>send(owner,'post','/finance/charges').send({residentId:r.id,bedId:beds[n].id,amount:'100',type:'RENT',billingPeriodStart:'2026-11-01',billingPeriodEnd:'2026-11-30',dueDate:'2026-11-05',gracePeriodDays:0,idempotencyKey:randomUUID()}).expect(201);

test('house changes reach staff after commit only; events carry no personal data',async()=>{
 const s=await open('/api/events',{Origin:origin,Cookie:ownerCookie});
 await send(owner,'post','/rooms').send({number:'2',capacity:1}).expect(201);
 assert.ok(await until(s.events,e=>e.topic==='house'));
 const count=s.events.length;
 await send(owner,'post','/rooms').send({number:'2',capacity:1}).expect(409);
 await sleep(500);assert.equal(s.events.length,count,'a rolled-back write publishes nothing');
 await send(owner,'post','/residents').send({fullName:'Секретное Имя',phone:'+998905000099'}).expect(201);
 assert.ok(await until(s.events,()=>s.events.length>count));
 for(const e of s.events){assert.ok(Object.keys(e).every(k=>['topic','type','id'].includes(k)));assert.ok(!JSON.stringify(e).includes('Секретное'));}
 s.ws.close();
});

test('staff events follow permissions and personal notifications reach only the recipient',async()=>{
 const finance=await staffWith(['FINANCE_VIEW'],'+998900000002'),none=await staffWith([],'+998900000003');
 const o=await open('/api/events',{Origin:origin,Cookie:ownerCookie}),f=await open('/api/events',{Origin:origin,Cookie:finance.cookie}),n=await open('/api/events',{Origin:origin,Cookie:none.cookie});
 const a=await tenant(1);
 await charge(a.resident,1);
 assert.ok(await until(o.events,e=>e.topic==='finance'&&e.type==='charge'));
 assert.ok(await until(f.events,e=>e.topic==='finance'));
 await bearer('post','/tenant/tickets',a.token).send({category:'REPAIR',title:'Течёт кран',body:'Течёт кран.'}).expect(201);
 assert.ok(await until(o.events,e=>e.topic==='tickets'&&e.type==='created'));
 assert.ok(await until(o.events,e=>e.topic==='notifications'));
 await sleep(400);
 assert.equal(n.events.filter(e=>['finance','tickets','notifications'].includes(e.topic)).length,0,'no rights, no events');
 assert.equal(f.events.filter(e=>e.topic==='tickets'||e.topic==='notifications').length,0);
 assert.ok(n.events.some(e=>e.topic==='house'),'every staff member sees house changes');
 for(const s of [o,f,n])s.ws.close();
});

test('tenants connect with a bearer token or their cookie and see only their own events',async()=>{
 const a=await tenant(1),b=await tenant(2);
 const ta=await open('/api/tenant/events',{Authorization:'Bearer '+a.token}),tb=await open('/api/tenant/events',{Authorization:'Bearer '+b.token});
 await charge(a.resident,1);
 assert.ok(await until(ta.events,e=>e.topic==='finance'));assert.ok(await until(ta.events,e=>e.topic==='notifications'));
 await sleep(300);assert.equal(tb.events.length,0,'another tenant hears nothing');
 assert.equal(ta.events.filter(e=>e.topic==='house').length,0,'tenants do not get staff topics');
 const login=await request(server).post('/api/tenant/auth/login').set('Origin',origin).set('X-Ijara-Request','1').send({phone:a.phone,password:'Tenant own password 1'}).expect(200);
 const web=await open('/api/tenant/events',{Origin:origin,Cookie:login.headers['set-cookie'][0].split(';')[0]});web.ws.close();
 for(const s of [ta,tb])s.ws.close();
});

test('wrong origins, mixed-up tokens and ended sessions are refused or closed',async()=>{
 const a=await tenant(1);
 await assert.rejects(open('/api/events',{Origin:'https://evil.example',Cookie:ownerCookie}));
 await assert.rejects(open('/api/events',{Cookie:ownerCookie}),'a cookie without Origin is not a browser we trust');
 await assert.rejects(open('/api/events',{Authorization:'Bearer '+a.token}),'a tenant token is not a staff session');
 await assert.rejects(open('/api/tenant/events',{Origin:origin,Cookie:ownerCookie}),'a staff cookie is not a tenant session');
 await assert.rejects(open('/api/other',{Origin:origin,Cookie:ownerCookie}));
 const s=await open('/api/tenant/events',{Authorization:'Bearer '+a.token});
 const closed=new Promise(r=>s.ws.once('close',r));
 await send(owner,'patch',`/residents/${a.resident.id}/app-account`).send({active:false}).expect(200);
 await Promise.race([closed,sleep(8000).then(()=>{throw Error('socket stayed open after access was closed');})]);
});
