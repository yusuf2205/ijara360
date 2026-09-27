const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {FinanceService}=require('../dist/finance');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test') throw Error('Dedicated test database required');
const db=new PrismaClient();let app,server,agent,actor,bed,resident,today;
const password='M3 isolated test password 2026';
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',process.env.APP_ORIGIN).set('X-Ijara-Request','1');
const reset=()=>db.$executeRawUnsafe('TRUNCATE audit_logs,sessions,users,occupancies,residents,beds,rooms,properties,rate_buckets CASCADE');
const date=(days=0)=>new Date(new Date(today+'T00:00:00Z').getTime()+days*86400000).toISOString().slice(0,10);
const chargeBody=(extra={})=>({residentId:resident.id,bedId:bed.id,amount:'100.10',type:'RENT',billingPeriodStart:date(-20),billingPeriodEnd:date(10),dueDate:today,gracePeriodDays:0,idempotencyKey:randomUUID(),...extra});
const charge=async(extra={})=>(await send(agent,'post','/finance/charges').send(chargeBody(extra)).expect(201)).body;
const payBody=(c,extra={})=>({chargeId:c.id,residentId:resident.id,amount:'100.10',method:'CASH',idempotencyKey:randomUUID(),...extra});
const pay=async(c,extra={})=>(await send(agent,'post','/finance/payments').send(payBody(c,extra)).expect(201)).body;
const snapshot=async()=>(await send(agent,'get','/finance').expect(200)).body;
const access=async()=>(await send(agent,'get',`/finance/residents/${resident.id}/access`).expect(200)).body;
before(async()=>{
 await db.$executeRawUnsafe("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ijara_app') THEN CREATE ROLE ijara_app; END IF; END $$");
 await require('../../../scripts/grant-runtime.cjs').grantRuntime(db);
 app=await createApp();await app.init();server=app.getHttpServer();today=(await db.$queryRawUnsafe("SELECT finance_today()::text AS business_day"))[0].business_day;
});
beforeEach(async()=>{
 await reset();await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Finance test',rooms:[{number:'1',capacity:2}]}).expect(201);
 agent=request.agent(server);await send(agent,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 actor=(await send(agent,'get','/auth/me')).body;bed=await db.bed.findFirst();
 resident=(await send(agent,'post','/residents').send({fullName:'Finance test resident',phone:'+998901234567'}).expect(201)).body;
});
after(async()=>{await reset();await app.close();await db.$disconnect();});
test('M3 initial financial state and empty summary',async()=>{
 const a=await access();assert.equal(a.access_granted,true);assert.equal(a.total_debt,'0');assert.equal(a.access_status_reason,'OK');
 assert.deepEqual((await snapshot()).summary,{charged:'0',paid:'0',applied:'0',creditBalance:'0',outstanding:'0',overdue:'0',blockedResidents:0});
});
test('M3 decimal partial and full payment update generated balance and status',async()=>{
 const c=await charge();assert.equal(c.dueAmount,'100.1');assert.equal(c.status,'UNPAID');
 await pay(c,{amount:'0.10'});let s=await snapshot();assert.equal(s.charges[0].status,'PARTIALLY_PAID');assert.equal(s.charges[0].dueAmount,'100');assert.equal(s.summary.paid,'0.1');
 await pay(c,{amount:'100'});s=await snapshot();assert.equal(s.charges[0].status,'PAID');assert.equal(s.summary.outstanding,'0');assert.equal((await access()).access_granted,true);
});
test('M3 overdue blocks, partial does not unblock, full settlement does',async()=>{
 const c=await charge({dueDate:date(-1)});assert.equal(c.status,'OVERDUE');assert.equal((await access()).access_granted,false);
 await pay(c,{amount:'50'});assert.equal((await access()).access_granted,false);assert.equal((await snapshot()).charges[0].status,'OVERDUE');
 await pay(c,{amount:'50.10'});assert.equal((await access()).access_granted,true);assert.equal((await access()).access_status_reason,'OK');
});
test('M3 due date and grace boundary are inclusive in Asia/Tashkent',async()=>{
 await charge({dueDate:today});assert.equal((await access()).access_granted,true);
 await charge({dueDate:date(-2),gracePeriodDays:2});assert.equal((await access()).access_granted,true);assert.equal((await access()).access_status_reason,'GRACE_PERIOD');
 await charge({dueDate:date(-3),gracePeriodDays:2});assert.equal((await access()).access_granted,false);
});
test('M3 one outstanding overdue charge keeps access denied across all charge types',async()=>{
 const charges=[];for(const type of ['RENT','DEPOSIT','PENALTY','UTILITIES','OTHER'])charges.push(await charge({type,dueDate:date(-1)}));
 for(const c of charges.slice(0,-1))await pay(c);
 assert.equal((await access()).access_granted,false);await pay(charges.at(-1));assert.equal((await access()).access_granted,true);
});
test('M3 identical request retries are idempotent, mismatched retries rejected',async()=>{
 const body=chargeBody();const c=(await send(agent,'post','/finance/charges').send(body).expect(201)).body;
 assert.equal((await send(agent,'post','/finance/charges').send(body).expect(201)).body.id,c.id);
 await send(agent,'post','/finance/charges').send({...body,amount:'101'}).expect(409);
 const p=payBody(c);const payment=(await send(agent,'post','/finance/payments').send(p).expect(201)).body;
 assert.equal((await send(agent,'post','/finance/payments').send(p).expect(201)).body.id,payment.id);
 await send(agent,'post','/finance/payments').send({...p,method:'OTHER'}).expect(409);
 assert.equal(await db.payment.count(),1);assert.equal(await db.auditLog.count({where:{action:'PAYMENT_RECORDED'}}),1);
});
test('M3 concurrent receipts do not overallocate; identical retries record once',async()=>{
 const c=await charge();let race=await Promise.all([1,2].map(()=>send(agent,'post','/finance/payments').send(payBody(c,{amount:'60'}))));assert.deepEqual(race.map(x=>x.status),[201,201]);
 assert.equal((await access()).credit_balance,'19.9');assert.equal((await db.charge.findUnique({where:{id:c.id}})).paidAmount.toString(),'100.1');
 const p=payBody(c,{amount:'40.10'});race=await Promise.all([1,2].map(()=>send(agent,'post','/finance/payments').send(p)));assert.deepEqual(race.map(x=>x.status),[201,201]);assert.equal(race[0].body.id,race[1].body.id);assert.equal((await access()).total_debt,'0');assert.equal((await access()).credit_balance,'60');
});
test('M3 input validation rejects rounded, zero, negative, non-string and malformed data',async()=>{
 for(const extra of [{amount:'0'},{amount:'-1'},{amount:'1.001'},{amount:10},{amount:'100000000'},{billingPeriodStart:'2026-02-30'},{billingPeriodEnd:date(-21)},{dueDate:'2026-02-30'},{gracePeriodDays:-1},{gracePeriodDays:366},{type:'INVALID'},{paidAmount:'10'},{status:'PAID'}])await send(agent,'post','/finance/charges').send(chargeBody(extra)).expect(422);
 const c=await charge();for(const extra of [{amount:'0'},{amount:'1.001'},{amount:-1},{method:'INVALID'}])await send(agent,'post','/finance/payments').send(payBody(c,extra)).expect(422);
 await send(agent,'post','/finance/payments').send(payBody(c,{amount:'101'})).expect(201);assert.equal((await access()).credit_balance,'0.9');
 await send(agent,'get','/finance?page=-1').expect(422);await send(agent,'get','/finance?status=INVALID').expect(422);
});
test('M3 authorization, CSRF, foreign IDs and wrong resident association',async()=>{
 await send(request(server),'get','/finance').expect(401);await agent.post('/api/finance/charges').send(chargeBody()).expect(403);
 const foreign=await db.property.create({data:{name:'Foreign'}});const r=await db.resident.create({data:{propertyId:foreign.id,fullName:'Foreign',phone:'+998909999999'}});
 await send(agent,'post','/finance/charges').send(chargeBody({residentId:r.id})).expect(404);
 await send(agent,'get','/finance?residentId='+r.id).expect(404);await send(agent,'get',`/finance/residents/${r.id}/access`).expect(404);
 const c=await charge();await send(agent,'post','/finance/payments').send(payBody(c,{residentId:r.id})).expect(404);
 await send(agent,'post','/finance/charges').send(chargeBody({bedId:randomUUID()})).expect(404);
});
test('M3 audit failure rolls back payment, aggregate and access atomically',async()=>{
 const c=await charge({dueDate:date(-1)});
 await db.$executeRawUnsafe("CREATE FUNCTION m3_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('PAYMENT_RECORDED','CHARGE_CREATED') THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$");
 await db.$executeRawUnsafe('CREATE TRIGGER m3_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION m3_fail_audit()');
 try{
  await send(agent,'post','/finance/payments').send(payBody(c)).expect(500);await send(agent,'post','/finance/charges').send(chargeBody()).expect(500);
  assert.equal(await db.payment.count(),0);assert.equal(await db.charge.count(),1);assert.equal((await access()).access_granted,false);assert.equal((await access()).total_debt,'100.1');
 }finally{await db.$executeRawUnsafe('DROP TRIGGER m3_fail_audit ON audit_logs');await db.$executeRawUnsafe('DROP FUNCTION m3_fail_audit()');}
});
test('M3 DB constraints protect generated balance, immutable history, ledger sums and scope',async()=>{
 const c=await charge();const p=await pay(c,{amount:'1'});
 await assert.rejects(db.payment.update({where:{id:p.id},data:{amount:2}}));await assert.rejects(db.payment.delete({where:{id:p.id}}));await assert.rejects(db.charge.delete({where:{id:c.id}}));
 await assert.rejects(db.charge.update({where:{id:c.id},data:{amount:50}}));await assert.rejects(db.charge.update({where:{id:c.id},data:{paidAmount:99}}));await assert.rejects(db.charge.update({where:{id:c.id},data:{dueAmount:0}}));
 await assert.rejects(db.paymentAllocation.create({data:{propertyId:actor.propertyId,residentId:resident.id,chargeId:c.id,paymentId:p.id,amount:200}}));
 const r=await db.resident.create({data:{propertyId:actor.propertyId,fullName:'Another',phone:'+998900000002'}});
 await assert.rejects(db.payment.create({data:{propertyId:actor.propertyId,residentId:r.id,chargeId:c.id,amount:1,createdByUserId:actor.id,idempotencyKey:randomUUID()}}));
});
test('M3 refresh worker restores stale projections and survives service restart',async()=>{
 await charge({dueDate:date(-1)});await db.resident.update({where:{id:resident.id},data:{accessGranted:true,totalDebt:0}});
 await app.get(FinanceService).tick();assert.equal((await db.resident.findUnique({where:{id:resident.id}})).accessGranted,false);
 await app.close();app=await createApp();await app.init();server=app.getHttpServer();agent=request.agent(server);await send(agent,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 assert.equal((await access()).access_granted,false);assert.equal((await snapshot()).charges.length,1);
});
test('M3 ADMIN records payment and disabled account cannot continue',async()=>{
 const admin=await send(agent,'post','/users').send({fullName:'Finance admin',phone:'+998900000003',password}).expect(201);
 const other=request.agent(server);await send(other,'post','/auth/login').send({phone:'+998900000003',password}).expect(200);
 const c=await charge();await send(other,'post','/finance/payments').send(payBody(c)).expect(201);
 assert.equal((await db.payment.findFirst()).createdByUserId,admin.body.id);
 await send(agent,'patch','/users/'+admin.body.id).send({active:false}).expect(200);await send(other,'get','/finance').expect(401);
});
test('M3 summary is exact above per-charge decimal limit; resident and status filters',async()=>{
 await charge({amount:'99999999.99',dueDate:date(-1)});await charge({amount:'99999999.99',dueDate:date(1)});
 const s=await snapshot();assert.equal(s.summary.outstanding,'199999999.98');assert.equal((await access()).total_debt,'199999999.98');
 const f=(await send(agent,'get',`/finance?residentId=${resident.id}&status=OVERDUE`).expect(200)).body;assert.equal(f.chargeCount,1);assert.equal(f.summary.outstanding,'199999999.98');
});
test('M3 runtime role can operate but cannot forge projections or erase ledger',async()=>{
 const existing=await db.$queryRawUnsafe("SELECT 1 FROM pg_roles WHERE rolname='ijara_app'");
 assert.equal(existing.length,1,'Apply grant-runtime.cjs on the test database first');
 const run=fn=>db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL ROLE ijara_app');return fn(tx);});
 const r=await run(tx=>tx.resident.create({data:{propertyId:actor.propertyId,fullName:'Runtime resident',phone:'+998901234568'}}));
 await run(tx=>tx.resident.update({where:{id:r.id},data:{note:'Runtime edit'}}));
 const c=await run(tx=>tx.charge.create({data:{propertyId:actor.propertyId,residentId:r.id,bedId:bed.id,roomId:bed.roomId,amount:'5.10',billingPeriodStart:new Date(today),billingPeriodEnd:new Date(today),dueDate:new Date(today),createdByUserId:actor.id,idempotencyKey:randomUUID()}}));
 await run(tx=>tx.payment.create({data:{propertyId:actor.propertyId,residentId:r.id,chargeId:c.id,amount:'5.10',createdByUserId:actor.id,idempotencyKey:randomUUID()}}));
 assert.equal((await db.charge.findUnique({where:{id:c.id}})).status,'PAID');
 await assert.rejects(run(tx=>tx.resident.update({where:{id:r.id},data:{accessGranted:false}})));
 await assert.rejects(run(tx=>tx.charge.update({where:{id:c.id},data:{paidAmount:0}})));
 await assert.rejects(run(tx=>tx.payment.deleteMany({where:{chargeId:c.id}})));
});
test('M3 FIFO splits one receipt across old debts with exact cents and retains advance',async()=>{
 const newer=await charge({amount:'80.20',dueDate:date(1)}),older=await charge({amount:'100.10',dueDate:date(-10)});
 const result=await pay(newer,{chargeId:undefined,amount:'150.15'});
 assert.equal(result.allocations.length,2);assert.equal(result.unallocatedAmount,'0');assert.equal(await db.payment.count(),1);
 const old=await db.charge.findUnique({where:{id:older.id}}),next=await db.charge.findUnique({where:{id:newer.id}});
 assert.equal(old.status,'PAID');assert.equal(next.paidAmount.toString(),'50.05');assert.equal(next.dueAmount.toString(),'30.15');assert.equal((await access()).access_granted,true);
 await pay(newer,{chargeId:undefined,amount:'50.25'});assert.equal((await access()).credit_balance,'20.1');assert.equal((await snapshot()).summary.paid,'200.4');
});
test('M3 advance with no charges automatically pays future charge, without a second receipt',async()=>{
 const body={residentId:resident.id,amount:'200.10',method:'BANK_TRANSFER',comment:'Advance',idempotencyKey:randomUUID()};
 const p=(await send(agent,'post','/finance/payments').send(body).expect(201)).body;assert.equal(p.chargeId,null);assert.equal(p.unallocatedAmount,'200.1');assert.equal((await access()).credit_balance,'200.1');
 const c=await charge({amount:'120.05',dueDate:date(-1)});assert.equal(c.status,'PAID');assert.equal(c.dueAmount,'0');assert.equal((await access()).access_granted,true);assert.equal((await access()).credit_balance,'80.05');
 const second=await charge({amount:'100.10',dueDate:date(-1)});assert.equal(second.status,'OVERDUE');assert.equal(second.dueAmount,'20.05');assert.equal((await access()).access_granted,false);assert.equal((await access()).credit_balance,'0');
 const retry=(await send(agent,'post','/finance/payments').send(body).expect(201)).body;assert.equal(retry.id,p.id);assert.equal(retry.allocations.length,2);assert.equal(await db.payment.count(),1);
});
test('M3 rollback restores advance and allocations if charge audit fails',async()=>{
 await send(agent,'post','/finance/payments').send({residentId:resident.id,amount:'100',method:'OTHER',idempotencyKey:randomUUID()}).expect(201);
 await db.$executeRawUnsafe("CREATE FUNCTION m3_credit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CHARGE_CREATED' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$");await db.$executeRawUnsafe('CREATE TRIGGER m3_credit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION m3_credit_fail()');
 try{await send(agent,'post','/finance/charges').send(chargeBody()).expect(500);assert.equal(await db.paymentAllocation.count(),0);assert.equal((await access()).credit_balance,'100');assert.equal(await db.charge.count(),0);}
 finally{await db.$executeRawUnsafe('DROP TRIGGER m3_credit_fail ON audit_logs');await db.$executeRawUnsafe('DROP FUNCTION m3_credit_fail()');}
});
test('M3 concurrent new charge and receipt conserve money; allocation history immutable',async()=>{
 await send(agent,'post','/finance/payments').send({residentId:resident.id,amount:'50.05',idempotencyKey:randomUUID()}).expect(201);
 const outcomes=await Promise.all([send(agent,'post','/finance/charges').send(chargeBody({amount:'75.10'})),send(agent,'post','/finance/payments').send({residentId:resident.id,amount:'50.05',idempotencyKey:randomUUID()})]);assert.deepEqual(outcomes.map(x=>x.status),[201,201]);
 const s=await snapshot();assert.equal(s.summary.paid,'100.1');assert.equal(s.summary.applied,'75.1');assert.equal(s.summary.creditBalance,'25');assert.equal(s.summary.outstanding,'0');
 const a=await db.paymentAllocation.findFirst();await assert.rejects(db.paymentAllocation.update({where:{id:a.id},data:{amount:1}}));await assert.rejects(db.paymentAllocation.delete({where:{id:a.id}}));
});
