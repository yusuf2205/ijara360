const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test') throw Error('Dedicated test database required');
const db=new PrismaClient();let app,server,owner,beds;
const password='M5 permissions test only password 2026';
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',process.env.APP_ORIGIN).set('X-Ijara-Request','1');
const reset=()=>db.$executeRawUnsafe('TRUNCATE audit_logs, sessions, users, occupancies, residents, beds, rooms, properties, rate_buckets CASCADE');
async function admin(phone='+998900000002'){
 const u=(await send(owner,'post','/users').send({phone,password,fullName:'Admin '+phone.slice(-2)}).expect(201)).body;
 const agent=request.agent(server);await send(agent,'post','/auth/login').send({phone,password}).expect(200);return {agent,u};
}
const rights=(a)=>send(a,'get','/permissions/me').expect(200).then(r=>r.body.permissions.sort());
before(async()=>{app=await createApp();await app.init();server=app.getHttpServer();});
beforeEach(async()=>{
 await reset();
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'M5 test',rooms:[{number:'1',capacity:2}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});
});
after(async()=>{await reset();await app.close();await db.$disconnect();});

test('a new ADMIN keeps the pre-M5 role: residents and finance, not rooms, property or staff',async()=>{
 const {agent,u}=await admin();
 assert.deepEqual(await rights(agent),['FINANCE_MANAGE','FINANCE_VIEW','RESIDENTS_MANAGE']);
 const r=(await send(agent,'post','/residents').send({fullName:'Resident',phone:'+998901000001'}).expect(201)).body;
 await send(agent,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[0].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 await send(agent,'get','/finance').expect(200);
 await send(agent,'post','/rooms').send({number:'9',capacity:2}).expect(403);
 await send(agent,'patch','/property').send({name:'Renamed'}).expect(403);
 await send(agent,'post','/users').send({phone:'+998900000003',password,fullName:'X'}).expect(403);
 const audit=await db.auditLog.findFirst({where:{action:'ADMIN_CREATED',entityId:u.id}});
 assert.deepEqual(audit.metadata.permissions,['RESIDENTS_MANAGE','FINANCE_VIEW','FINANCE_MANAGE']);
});

test('withdrawn permissions close residents and finance on the server, reads stay available',async()=>{
 const {agent,u}=await admin();
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:[]}).expect(200);
 await send(agent,'get','/finance').expect(403);
 await send(agent,'get','/finance/residents/00000000-0000-4000-8000-000000000000/access').expect(403);
 const denied=await send(agent,'post','/residents').send({fullName:'Resident',phone:'+998901000002'}).expect(403);
 assert.equal(denied.body.message,'У вас нет доступа к этой функции.');
 await send(agent,'get','/residents').expect(200);
 await send(agent,'get','/rooms').expect(200);
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:['FINANCE_VIEW']}).expect(200);
 await send(agent,'get','/finance').expect(200);
 const r=(await send(owner,'post','/residents').send({fullName:'Resident',phone:'+998901000003'}).expect(201)).body;
 await send(agent,'post','/finance/payments').send({residentId:r.id,amount:'1000',method:'CASH',idempotencyKey:'7f4c1e2a-5b6d-4c8e-9f0a-1b2c3d4e5f60'}).expect(403);
});

test('ROOMS_MANAGE opens rooms only; staff and property stay owner-only',async()=>{
 const a=await admin();const b=await admin('+998900000004');
 await send(owner,'put',`/permissions/users/${a.u.id}`).send({permissions:['ROOMS_MANAGE']}).expect(200);
 const room=(await send(a.agent,'post','/rooms').send({number:'9',capacity:2}).expect(201)).body;
 const bigger=(await send(a.agent,'patch',`/rooms/${room.id}`).send({number:'9',capacity:3,version:room.version}).expect(200)).body;
 assert.equal(bigger.capacity,3);
 await send(a.agent,'post',`/rooms/${room.id}/beds`).send({number:'3'}).expect(201);
 await send(a.agent,'patch',`/users/${b.u.id}`).send({active:false}).expect(403);
 await send(a.agent,'patch','/property').send({name:'Renamed'}).expect(403);
 await send(a.agent,'put',`/permissions/users/${b.u.id}`).send({permissions:['ROOMS_MANAGE']}).expect(403);
 assert.equal((await db.user.findUnique({where:{id:b.u.id}})).active,true);
 await send(owner,'patch','/property').send({name:'Renamed'}).expect(200);
});

test('owner keeps every permission and cannot be restricted',async()=>{
 const all=await rights(owner);
 for(const code of ['ROOMS_MANAGE','RESIDENTS_MANAGE','FINANCE_VIEW','FINANCE_MANAGE','APPLICATION_VIEW'])assert.ok(all.includes(code),code);
 const self=await db.user.findFirst({where:{role:'OWNER'}});
 await send(owner,'put',`/permissions/users/${self.id}`).send({permissions:[]}).expect(403);
});
