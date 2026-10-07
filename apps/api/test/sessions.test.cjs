const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test') throw Error('Dedicated test database required');
const db=new PrismaClient();let app,server,owner;
const password='M5 sessions test only password 2026';
const origin=process.env.APP_ORIGIN;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const reset=()=>db.$executeRawUnsafe('TRUNCATE audit_logs, sessions, users, occupancies, residents, beds, rooms, properties, rate_buckets CASCADE');
const chromeWindows='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const appLogin=(phone='+998900000001',extra={})=>request(server).post('/api/auth/login').set('X-Ijara-Request','1').send({phone,password,platform:'ANDROID',deviceName:'Galaxy A52',remember:true,...extra});
const bearer=(m,p,token)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+token).set('X-Ijara-Request','1');
const days=ms=>Math.round(ms/86400000);
before(async()=>{app=await createApp();await app.init();server=app.getHttpServer();});
beforeEach(async()=>{
 await reset();
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'M5 sessions',rooms:[{number:'1',capacity:2}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').set('User-Agent',chromeWindows).send({phone:'+998900000001',password}).expect(200);
});
after(async()=>{await reset();await app.close();await db.$disconnect();});

test('browser sessions last 24 hours, remembered ones 30 days, and are listed with a device label',async()=>{
 const remembered=request.agent(server);
 const res=await send(remembered,'post','/auth/login').set('User-Agent',chromeWindows).send({phone:'+998900000001',password,remember:true}).expect(200);
 assert.equal(days(new Date(res.body.expiresAt)-Date.now()),30);
 assert.match(res.headers['set-cookie'].join(';'),/ijara_session=.*HttpOnly/i);
 const list=(await send(owner,'get','/auth/sessions').expect(200)).body;
 assert.equal(list.length,2);
 const current=list.find(s=>s.current);
 assert.equal(current.deviceName,'Windows · Chrome');assert.equal(current.platform,'WEB');assert.equal(current.remembered,false);
 assert.equal(days(new Date(current.expiresAt)-Date.now()),1);
 assert.ok(current.lastSeenAt);
 assert.equal(list.filter(s=>s.remembered).length,1);
});

test('apps get a bearer token, not a cookie, and can write without Origin',async()=>{
 const res=await appLogin().expect(200);
 assert.equal(res.headers['set-cookie'],undefined);
 assert.ok(res.body.token.length>=40);
 const token=res.body.token;
 assert.equal((await bearer('get','/auth/me',token).expect(200)).body.role,'OWNER');
 await bearer('post','/residents',token).send({fullName:'App Resident',phone:'+998901000009'}).expect(201);
 const s=await db.session.findFirst({where:{platform:'ANDROID'}});
 assert.equal(s.deviceName,'Galaxy A52');assert.equal(s.remembered,true);
 // A bearer request needs no custom header; a login without Origin and without it is refused.
 await request(server).post('/api/residents').set('Authorization','Bearer '+token).send({fullName:'X',phone:'+998901000010'}).expect(201);
 await request(server).post('/api/auth/login').send({phone:'+998900000001',password}).expect(403);
 await bearer('get','/auth/me','not-a-real-token').expect(401);
});

test('a cookie request from a foreign origin stays blocked even with a bearer header',async()=>{
 const token=(await appLogin().expect(200)).body.token;
 await owner.post('/api/residents').set('Origin','https://evil.invalid').set('X-Ijara-Request','1').set('Authorization','Bearer '+token).send({fullName:'X',phone:'+998901000011'}).expect(403);
 await owner.post('/api/residents').set('X-Ijara-Request','1').send({fullName:'X',phone:'+998901000012'}).expect(403);
});

test('users end their own sessions; only the owner ends other staff sessions',async()=>{
 const phone='+998900000002';
 await send(owner,'post','/users').send({phone,password,fullName:'Admin'}).expect(201);
 const adminToken=(await appLogin(phone).expect(200)).body.token;
 const adminSecond=(await appLogin(phone,{deviceName:'Old phone'}).expect(200)).body.token;
 const ownerApp=(await appLogin().expect(200)).body.token;
 const adminSessions=(await bearer('get','/auth/sessions',adminToken).expect(200)).body;
 assert.equal(adminSessions.length,2);
 const old=adminSessions.find(s=>s.deviceName==='Old phone');
 await bearer('delete',`/auth/sessions/${old.id}`,adminToken).expect(200);
 await bearer('get','/auth/me',adminSecond).expect(401);
 const ownerAppSession=(await bearer('get','/auth/sessions',ownerApp).expect(200)).body.find(s=>s.current);
 await bearer('delete',`/auth/sessions/${ownerAppSession.id}`,adminToken).expect(403);
 await bearer('get','/auth/staff-sessions',adminToken).expect(403);
 const all=(await send(owner,'get','/auth/staff-sessions').expect(200)).body;
 const adminCurrent=all.find(s=>s.user.fullName==='Admin');
 await send(owner,'delete',`/auth/sessions/${adminCurrent.id}`).expect(200);
 await bearer('get','/auth/me',adminToken).expect(401);
 const audit=await db.auditLog.findMany({where:{action:'SESSION_REVOKED'},orderBy:{createdAt:'asc'}});
 assert.deepEqual(audit.map(a=>a.metadata.own),[true,false]);
 await send(owner,'delete',`/auth/sessions/${adminCurrent.id}`).expect(404);
});

test('logout ends a bearer session too',async()=>{
 const token=(await appLogin().expect(200)).body.token;
 await bearer('post','/auth/logout',token).expect(204);
 await bearer('get','/auth/me',token).expect(401);
});
