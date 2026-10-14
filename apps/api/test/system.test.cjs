const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
const dir='/tmp/ijara360-status-test';
process.env.SERVER_STATUS_PATH=dir;
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='System status test password 2026';
let app,server,owner;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const write=v=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/watchdog.json`,JSON.stringify(v));};
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();});
beforeEach(async()=>{fs.rmSync(dir,{recursive:true,force:true});await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Status',rooms:[{number:'1',capacity:1}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);});
after(async()=>{fs.rmSync(dir,{recursive:true,force:true});await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

test('the owner sees the watchdog status; only known fields pass, an old file is marked stale',async()=>{
 assert.deepEqual((await send(owner,'get','/system/status').expect(200)).body,{available:false});
 const now=new Date().toISOString();
 write({checkedAt:now,checks:[{key:'internet',label:'Вход из интернета',ok:false,detail:'нет ответа',since:now,extra:'x'},{key:'evil',label:'?',ok:true},{key:'backup',label:'Ночная резервная копия',ok:null,detail:'ждём первую копию'}],
  backup:{at:now,bytes:1024,documents:3,path:'/secret'},disk:{free:5,total:10},telegram:true,token:'never'});
 const s=(await send(owner,'get','/system/status').expect(200)).body;
 assert.equal(s.available,true);assert.equal(s.stale,false);assert.equal(s.telegram,true);
 assert.deepEqual(s.checks.map(c=>[c.key,c.ok]),[['internet',false],['backup',null]]);
 assert.equal(s.checks[0].extra,undefined);
 assert.deepEqual(s.backup,{at:now,bytes:1024,documents:3});
 assert.deepEqual(s.disk,{free:5,total:10});
 assert.equal(JSON.stringify(s).includes('never'),false);
 write({checkedAt:new Date(Date.now()-10*60000).toISOString(),checks:[]});
 assert.equal((await send(owner,'get','/system/status').expect(200)).body.stale,true);
});

test('administrators and anonymous visitors cannot read the server status',async()=>{
 write({checkedAt:new Date().toISOString(),checks:[]});
 const u=(await send(owner,'post','/users').send({phone:'+998900000002',password,fullName:'Admin'}).expect(201)).body;
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:['FINANCE_VIEW','FINANCE_MANAGE','RESIDENTS_MANAGE','ROOMS_MANAGE','TICKETS_MANAGE']}).expect(200);
 const admin=request.agent(server);await send(admin,'post','/auth/login').send({phone:u.phone,password}).expect(200);
 await send(admin,'get','/system/status').expect(403);
 await send(request(server),'get','/system/status').expect(401);
});
