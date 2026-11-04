const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {ResidentsService,stayStage}=require('../dist/residents');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='End of stay test password 2026';
let app,server,owner,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
const day=(offset)=>{const t=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(new Date(t+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);};
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'End of stay',rooms:[{number:'1',capacity:4}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

/** A living resident with an activated app account, checked in 40 days ago. */
async function tenant(n,extra={}){
 const phone='+99890300000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Resident '+n,phone}).expect(201)).body;
 const o=(await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:day(-40),monthlyPrice:'500000',paymentDay:5,depositAmount:'0',...extra}).expect(201)).body;
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 const token=(await request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID'}).expect(200)).body.token;
 return {resident:r,occupancy:o,token};
}
const plan=(o,date)=>send(owner,'put',`/occupancies/${o.id}/plan`).send({plannedEndDate:date});
const feed=(kind)=>db.notification.findMany({where:{kind},orderBy:{createdAt:'asc'}});
const remind=()=>app.get(ResidentsService).remindStays();

test('reminder stages: two weeks, three days, the last day, overdue',()=>{
 assert.deepEqual([30,15,14,4,3,1,0,-1,-30].map(stayStage),[0,0,1,1,2,2,3,4,4]);
});

test('the end of stay is set at check-in, shown to staff and the resident, and validated',async()=>{
 const {resident,occupancy,token}=await tenant(1,{plannedEndDate:day(60)});
 const detail=(await send(owner,'get',`/residents/${resident.id}`).expect(200)).body;
 assert.equal(detail.occupancies[0].plan.plannedEndDate.slice(0,10),day(60));
 assert.equal((await bearer('get','/tenant/me',token).expect(200)).body.occupancy.plannedEndDate.slice(0,10),day(60));
 const log=await db.auditLog.findFirst({where:{action:'OCCUPANCY_CHECKED_IN',entityId:resident.id}});assert.equal(log.metadata.plannedEndDate,day(60));
 // Not before move-in, a real date, at most 10 years.
 await plan(occupancy,day(-40)).expect(422);await plan(occupancy,'2026-02-30').expect(422);await plan(occupancy,day(3700)).expect(422);
 const other=(await send(owner,'post','/residents').send({fullName:'No plan',phone:'+998903000099'}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:other.id,bedId:beds[3].id,moveInDate:day(0),monthlyPrice:'1',paymentDay:5,depositAmount:'0',plannedEndDate:day(0)}).expect(422);
 assert.equal(await db.occupancy.count({where:{residentId:other.id}}),0,'a refused plan rolls the whole check-in back');
});

test('extending tells the resident, resets reminders and is audited; removing works; checked-out stays are refused',async()=>{
 const {resident,occupancy}=await tenant(1,{plannedEndDate:day(2)});
 assert.equal(await remind(),1);assert.equal((await db.occupancyPlan.findUnique({where:{occupancyId:occupancy.id}})).reminderStage,2);
 await plan(occupancy,day(90)).expect(200);
 const row=await db.occupancyPlan.findUnique({where:{occupancyId:occupancy.id}});assert.equal(row.reminderStage,0);assert.equal(row.plannedEndDate.toISOString().slice(0,10),day(90));
 const changed=await feed('STAY_PLAN_CHANGED');assert.equal(changed.length,1);assert.match(changed[0].body,/до \d+ \S+ \d{4}/);
 const log=await db.auditLog.findFirst({where:{action:'OCCUPANCY_PLAN_SET'}});assert.deepEqual([log.metadata.from,log.metadata.to],[day(2),day(90)]);
 await plan(occupancy,day(90)).expect(200);assert.equal((await feed('STAY_PLAN_CHANGED')).length,1,'the same date again changes nothing');
 await send(owner,'put',`/occupancies/${occupancy.id}/plan`).send({plannedEndDate:null}).expect(200);
 assert.equal(await db.occupancyPlan.count(),0);assert.equal((await feed('STAY_PLAN_CHANGED')).at(-1).body,'Дата окончания проживания снята.');
 await send(owner,'post',`/occupancies/${occupancy.id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 await plan(occupancy,day(30)).expect(409);
 assert.equal(resident.id,occupancy.residentId);
});

test('each reminder is sent once: resident at 14 and 3 days and on the day, staff at 3 days and overdue',async()=>{
 const {occupancy}=await tenant(1,{plannedEndDate:day(14)});
 const setEnd=d=>db.occupancyPlan.update({where:{occupancyId:occupancy.id},data:{plannedEndDate:new Date(d+'T00:00:00Z')}});
 assert.equal(await remind(),1);assert.equal(await remind(),0,'the same stage is not sent twice');
 let resident=await db.notification.findMany({where:{kind:'STAY_ENDING',tenantAccountId:{not:null}}});
 assert.equal(resident.length,1);assert.match(resident[0].body,/через 14 дн\./);
 assert.equal(await db.notification.count({where:{kind:'STAY_ENDING',userId:{not:null}}}),0,'staff are not bothered two weeks ahead');
 await setEnd(day(3));assert.equal(await remind(),1);
 const staff=await db.notification.findMany({where:{kind:'STAY_ENDING',userId:{not:null}}});
 assert.equal(staff.length,1);assert.equal(staff[0].title,'Скоро выезд');assert.match(staff[0].body,/^Resident 1, комната 1, место \d+: срок проживания заканчивается/);assert.equal(staff[0].link,`/residents/${occupancy.residentId}`);
 await setEnd(day(0));assert.equal(await remind(),1);
 resident=await db.notification.findMany({where:{kind:'STAY_ENDING',tenantAccountId:{not:null}},orderBy:{createdAt:'asc'}});assert.equal(resident.length,3);assert.match(resident[2].body,/заканчивается сегодня/);
 await setEnd(day(-1));assert.equal(await remind(),1);assert.equal(await remind(),0);
 const overdue=await db.notification.findMany({where:{kind:'STAY_ENDING',userId:{not:null}},orderBy:{createdAt:'asc'}});
 assert.equal(overdue.length,3,'staff: three days, last day, overdue');assert.equal(overdue[2].title,'Срок проживания истёк');
 assert.equal(await db.notification.count({where:{kind:'STAY_ENDING',tenantAccountId:{not:null}}}),3,'the resident is not told after the date');
 assert.equal((await db.occupancy.findUnique({where:{id:occupancy.id}})).status,'ACTIVE','nobody is checked out automatically');
});

test('a plan set close to its date sends only the current stage; checked-out stays get nothing',async()=>{
 const a=await tenant(1,{plannedEndDate:day(2)});const b=await tenant(2,{plannedEndDate:day(10)});
 await send(owner,'post',`/occupancies/${b.occupancy.id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 assert.equal(await remind(),1);
 const sent=await db.notification.findMany({where:{kind:'STAY_ENDING',tenantAccountId:{not:null}}});
 assert.equal(sent.length,1);assert.match(sent[0].body,/через 2 дн\./);assert.equal(sent[0].entityId,a.occupancy.id);
});

test('a transfer keeps the end of stay and the reminders already sent; the ending list shows soonest first',async()=>{
 const a=await tenant(1,{plannedEndDate:day(3)});await tenant(2,{plannedEndDate:day(-2)});await tenant(3,{plannedEndDate:day(45)});
 await remind();
 const moved=(await send(owner,'post',`/occupancies/${a.occupancy.id}/transfer`).send({bedId:beds[0].id,transferDate:day(0)}).expect(201)).body;
 const kept=await db.occupancyPlan.findUnique({where:{occupancyId:moved.id}});assert.equal(kept.plannedEndDate.toISOString().slice(0,10),day(3));assert.equal(kept.reminderStage,2);
 const before=await db.notification.count();assert.equal(await remind(),0);assert.equal(await db.notification.count(),before,'no repeat after the transfer');
 const ending=(await send(owner,'get','/occupancies/ending').expect(200)).body;
 assert.deepEqual(ending.map(e=>[e.fullName,e.daysLeft]),[['Resident 2',-2],['Resident 1',3]],'overdue first, then within 30 days; 45 days out is not listed');
});

test('conversion of an approved application can carry the end of stay',async()=>{
 const {conversionCheckIn}=require('../dist/applications.dto');
 const dto=conversionCheckIn({bedId:beds[0].id,moveInDate:day(0),monthlyPrice:'1',paymentDay:1,depositAmount:'0',plannedEndDate:day(100),version:1},undefined,{fullName:'X',phone:'+998900000077'});
 assert.equal(dto.plannedEndDate,day(100));
 assert.equal(conversionCheckIn({bedId:beds[0].id,moveInDate:day(0),monthlyPrice:'1',paymentDay:1,depositAmount:'0',version:1},undefined,{fullName:'X',phone:'+998900000077'}).plannedEndDate,undefined);
});
