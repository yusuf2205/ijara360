const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const sharp=require('sharp');
const {randomBytes}=require('node:crypto');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {PhoneVerificationService}=require('../dist/phone-verification');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Tenant test only password 2026';
let app,server,owner,phoneService,telegram,sent,image,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
const profile={fullName:'Tenant Applicant',dateOfBirth:'2000-01-01',pinfl:'12345678901234',passportSeries:'AA',passportNumber:'1234567',occupationType:'STUDENT',organization:'Test university',requestedMoveInDate:'2026-10-01',plannedDuration:'12 months',emergencyName:'Test Contact',emergencyRelationship:'Parent',emergencyPhone:'+998900000055',consent:true};
const tokenFrom=url=>new URL(url).hash.slice(1);
const tenantLogin=(phone,extra={})=>request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID',deviceName:'Test phone',...extra});
before(async()=>{await grantRuntime(db);image=await sharp(randomBytes(640*640*3),{raw:{width:640,height:640,channels:3}}).png().toBuffer();app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();
 telegram=app.get(TelegramService);phoneService=app.get(PhoneVerificationService);telegram.call=async(method,body)=>{sent.push({method,body});return true;};});
beforeEach(async()=>{sent=[];await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Tenant test',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

async function convertedApplicant(phone='+998900000022',tgId=22){
 const agent=request.agent(server);await send(agent,'post','/public/applications').send({phone,channel:'WEB'}).expect(201);
 const link=(await send(agent,'post','/public/applications/phone').expect(201)).body;const start=new URL(link.url).searchParams.get('start');
 await phoneService.handle({update_id:1,message:{from:{id:tgId},chat:{id:tgId,type:'private'},text:`/start ${start}`}});
 await phoneService.handle({update_id:2,message:{from:{id:tgId},chat:{id:tgId,type:'private'},contact:{user_id:tgId,phone_number:phone}}});
 const me=()=>send(agent,'get','/public/applications/me').expect(200).then(r=>r.body);
 await send(agent,'patch','/public/applications/me').send({...profile,version:(await me()).version}).expect(200);
 for(const kind of ['PASSPORT_FRONT','PASSPORT_BACK','FACE'])await send(agent,'put',`/public/applications/documents/${kind}`).set('Content-Type','image/png').send(image).expect(200);
 let a=await me();await send(agent,'post','/public/applications/submit').send({version:a.version}).expect(201);a=await me();
 a=(await send(owner,'post',`/applications/${a.id}/review`).send({version:a.version,status:'UNDER_REVIEW'}).expect(201)).body;
 a=(await send(owner,'post',`/applications/${a.id}/review`).send({version:a.version,status:'APPROVED',identityReviewed:true,documentsReviewed:true,faceQualityConfirmed:true}).expect(201)).body;
 sent=[];
 return (await send(owner,'post',`/applications/${a.id}/convert`).send({version:a.version,bedId:beds[0].id,moveInDate:'2026-10-01',monthlyPrice:'900000',paymentDay:5,depositAmount:'0'}).expect(201)).body;
}
async function livingResident(n=1){
 const r=(await send(owner,'post','/residents').send({fullName:'Manual Resident '+n,phone:'+99890100000'+n}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 return r;
}

test('converted applicant receives a Telegram invite, sets a password once and signs in to the tenant API only',async()=>{
 const result=await convertedApplicant();
 assert.deepEqual({channel:result.appInvite.channel,delivered:result.appInvite.delivered},{channel:'TELEGRAM',delivered:true});
 assert.equal(result.appInvite.link,undefined,'a Telegram invite is never shown to staff');
 const msg=sent.find(s=>s.method==='sendMessage');assert.equal(msg.body.chat_id,'22');
 assert.match(msg.body.text,/комната 1, место 1/);
 const url=msg.body.reply_markup.inline_keyboard[0][0].url;assert.match(url,/\/invite#[A-Za-z0-9_-]{32,}$/);
 const token=tokenFrom(url);
 const info=(await send(request(server),'post','/tenant/invites/inspect').send({token}).expect(200)).body;
 assert.equal(info.firstName,'Tenant');assert.doesNotMatch(info.phone,/900000022/,'phone is masked');
 await send(request(server),'post','/tenant/invites/accept').send({token,password:'short'}).expect(422);
 await send(request(server),'post','/tenant/invites/accept').send({token,password:'1234567'}).expect(422);
 assert.equal((await send(request(server),'post','/tenant/invites/accept').send({token,password:'Tenant own password 1'}).expect(200)).body.phone,'+998900000022');
 await send(request(server),'post','/tenant/invites/accept').send({token,password:'Tenant own password 2'}).expect(410);
 const login=(await tenantLogin('+998900000022').expect(200)).body;
 const me=(await bearer('get','/tenant/me',login.token).expect(200)).body;
 assert.equal(me.occupancy.room,'1');assert.equal(me.occupancy.bed,'1');assert.equal(me.fullName,'Tenant Applicant');
 await bearer('get','/residents',login.token).expect(401);
 await bearer('get','/auth/me',login.token).expect(401);
 const ownerApp=(await request(server).post('/api/auth/login').set('X-Ijara-Request','1').send({phone:'+998900000001',password,platform:'ANDROID'}).expect(200)).body.token;
 await bearer('get','/tenant/me',ownerApp).expect(401);
 await tenantLogin('+998900000022',{password:'wrong password here'}).expect(401);
 const audit=(await db.auditLog.findMany({where:{action:{in:['TENANT_INVITE_CREATED','TENANT_ACCOUNT_ACTIVATED']}},orderBy:{createdAt:'asc'}})).map(a=>a.action);
 assert.deepEqual(audit,['TENANT_INVITE_CREATED','TENANT_ACCOUNT_ACTIVATED']);
});

test('staff invite a manually checked-in resident by link; a newer invite cancels the older one',async()=>{
 const r=await livingResident();
 assert.equal((await send(owner,'get',`/residents/${r.id}/app-account`).expect(200)).body.status,'NONE');
 const first=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body;
 assert.equal(first.channel,'LINK');assert.equal(first.delivered,false);assert.ok(first.link.includes('/invite#'));
 assert.equal(sent.length,0,'no Telegram account is known');
 const second=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body;
 await send(request(server),'post','/tenant/invites/inspect').send({token:tokenFrom(first.link)}).expect(410);
 assert.equal((await send(owner,'get',`/residents/${r.id}/app-account`).expect(200)).body.status,'INVITED');
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(second.link),password:'Tenant own password 1'}).expect(200);
 const web=request.agent(server);
 const res=await send(web,'post','/tenant/auth/login').send({phone:'+998901000001',password:'Tenant own password 1'}).expect(200);
 assert.match(res.headers['set-cookie'].join(';'),/ijara_tenant=.*Path=\/api\/tenant.*HttpOnly/i);
 assert.equal((await send(web,'get','/tenant/me').expect(200)).body.occupancy.bed,'2');
 const st=(await send(owner,'get',`/residents/${r.id}/app-account`).expect(200)).body;
 assert.equal(st.status,'ACTIVE');assert.equal(st.activeSessions,1);
});

test('checkout closes app access in the same transaction; a new invite after re-check-in reopens it',async()=>{
 const r=await livingResident();
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(link),password:'Tenant own password 1'}).expect(200);
 const token=(await tenantLogin('+998901000001').expect(200)).body.token;
 const pending=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 const occ=await db.occupancy.findFirst({where:{residentId:r.id,status:'ACTIVE'}});
 await send(owner,'post',`/occupancies/${occ.id}/check-out`).send({moveOutDate:'2026-10-05'}).expect(201);
 await bearer('get','/tenant/me',token).expect(401);
 await tenantLogin('+998901000001').expect(401);
 await send(request(server),'post','/tenant/invites/inspect').send({token:tokenFrom(pending)}).expect(410);
 assert.equal((await send(owner,'get',`/residents/${r.id}/app-account`).expect(200)).body.status,'DISABLED');
 const audit=await db.auditLog.findFirst({where:{action:'TENANT_ACCOUNT_DISABLED'}});assert.equal(audit.metadata.reason,'CHECKED_OUT');
 await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(409);
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[2].id,moveInDate:'2026-10-06',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 const again=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(again),password:'Tenant own password 1'}).expect(200);
 assert.equal((await bearer('get','/tenant/me',(await tenantLogin('+998901000001').expect(200)).body.token).expect(200)).body.occupancy.bed,'3');
});

test('expired invites, permissions and manual disable are enforced on the server',async()=>{
 const r=await livingResident();
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await db.tenantInvite.updateMany({data:{expiresAt:new Date(Date.now()-1000)}});
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(link),password:'Tenant own password 1'}).expect(410);
 const u=(await send(owner,'post','/users').send({phone:'+998900000002',password,fullName:'Admin'}).expect(201)).body;
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:['FINANCE_VIEW']}).expect(200);
 const admin=request.agent(server);await send(admin,'post','/auth/login').send({phone:'+998900000002',password}).expect(200);
 await send(admin,'post',`/residents/${r.id}/app-invite`).send({}).expect(403);
 const fresh=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(fresh),password:'Tenant own password 1'}).expect(200);
 const token=(await tenantLogin('+998901000001').expect(200)).body.token;
 await send(admin,'patch',`/residents/${r.id}/app-account`).send({active:false}).expect(403);
 await send(owner,'patch',`/residents/${r.id}/app-account`).send({active:false}).expect(200);
 await bearer('get','/tenant/me',token).expect(401);
 const outsider=(await send(owner,'post','/residents').send({fullName:'Not living',phone:'+998901000009'}).expect(201)).body;
 await send(owner,'post',`/residents/${outsider.id}/app-invite`).send({}).expect(409);
});

test('a Telegram outage does not undo the conversion and leaves the invite usable',async()=>{
 telegram.call=async(method,body)=>{if(method==='sendMessage'&&body.reply_markup?.inline_keyboard)throw new (require('@nestjs/common').ServiceUnavailableException)();sent.push({method,body});return true;};
 try{
  const result=await convertedApplicant();
  assert.equal(result.appInvite.delivered,false);
  assert.equal((await db.occupancy.count({where:{status:'ACTIVE'}})),1);
  const resent=(await send(owner,'post',`/residents/${result.residentId}/app-invite`).send({channel:'LINK'}).expect(200)).body;
  await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(resent.link),password:'Tenant own password 1'}).expect(200);
 }finally{telegram.call=async(method,body)=>{sent.push({method,body});return true;};}
});

test('tenants list and end their own sessions; a new password signs out every device',async()=>{
 const r=await livingResident();
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(link),password:'Tenant own password 1'}).expect(200);
 const a=(await tenantLogin('+998901000001',{deviceName:'Phone A'}).expect(200)).body.token;
 const b=(await tenantLogin('+998901000001',{deviceName:'Phone B'}).expect(200)).body.token;
 const list=(await bearer('get','/tenant/sessions',a).expect(200)).body;assert.equal(list.length,2);
 await bearer('delete',`/tenant/sessions/${list.find(s=>s.deviceName==='Phone B').id}`,a).expect(200);
 await bearer('get','/tenant/me',b).expect(401);
 const reset=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:tokenFrom(reset),password:'Tenant own password 2'}).expect(200);
 await bearer('get','/tenant/me',a).expect(401);
 assert.ok(await db.auditLog.findFirst({where:{action:'TENANT_PASSWORD_RESET'}}));
});
