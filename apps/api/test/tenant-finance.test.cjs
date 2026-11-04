const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {randomUUID}=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Tenant finance test password 2026';
let app,server,owner,ownerToken,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
const day=(offset)=>{const t=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(new Date(t+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);};
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Tenant finance',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 ownerToken=(await request(server).post('/api/auth/login').set('X-Ijara-Request','1').send({phone:'+998900000001',password,platform:'ANDROID'}).expect(200)).body.token;
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

/** A living resident with an activated app account; returns the resident and a tenant bearer token. */
async function tenant(n){
 const phone='+99890200000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Tenant '+n,phone}).expect(201)).body;
 await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:day(-40),monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 const token=(await request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID'}).expect(200)).body.token;
 return {resident:r,token};
}
const charge=(r,extra)=>send(owner,'post','/finance/charges').send({residentId:r.id,bedId:beds[Number(r.fullName.slice(-1))].id,amount:'500000',type:'RENT',billingPeriodStart:day(-40),billingPeriodEnd:day(-10),dueDate:day(-5),gracePeriodDays:0,idempotencyKey:randomUUID(),...extra}).expect(201).then(x=>x.body);
const pay=(r,amount,extra={})=>send(owner,'post','/finance/payments').send({residentId:r.id,amount,method:'CASH',comment:'Внутренняя заметка сотрудника',idempotencyKey:randomUUID(),...extra}).expect(201).then(x=>x.body);

test('a tenant sees only their own debt, overdue status, next charge and rent terms',async()=>{
 const a=await tenant(1),b=await tenant(2);
 await charge(a.resident);await charge(a.resident,{amount:'500000',billingPeriodStart:day(-9),billingPeriodEnd:day(20),dueDate:day(25)});
 await charge(b.resident,{amount:'777000'});
 const s=(await bearer('get','/tenant/finance',a.token).expect(200)).body;
 assert.deepEqual(s.access,{granted:false,reason:'OVERDUE'});
 assert.equal(String(s.totalDebt),'1000000');assert.equal(String(s.overdue.amount),'500000');assert.equal(s.overdue.count,1);
 assert.equal(s.nextCharge.dueDate.slice(0,10),day(-5));assert.equal(s.nextCharge.status,'OVERDUE');
 assert.deepEqual({room:s.rent.room,bed:s.rent.bed,paymentDay:s.rent.paymentDay},{room:'1',bed:'2',paymentDay:5});
 const list=(await bearer('get','/tenant/charges',a.token).expect(200)).body;
 assert.equal(list.total,2);assert.ok(list.items.every(c=>String(c.amount)==='500000'),'no charge of another tenant');
 assert.equal(list.items[0].dueDate.slice(0,10),day(25),'newest due date first');
 const json=JSON.stringify(list);
 for(const field of ['idempotencyKey','createdByUserId','residentId','propertyId','creator'])assert.ok(!json.includes(field),field+' is not exposed');
});

test('payments clear access, show allocations and credit, and never expose staff comments or names',async()=>{
 const a=await tenant(1),b=await tenant(2);
 const c=await charge(a.resident);await pay(b.resident,'100000');
 await pay(a.resident,'200000',{chargeId:c.id});
 let s=(await bearer('get','/tenant/finance',a.token).expect(200)).body;assert.equal(s.access.granted,false);
 await pay(a.resident,'400000');
 s=(await bearer('get','/tenant/finance',a.token).expect(200)).body;
 assert.deepEqual(s.access,{granted:true,reason:'OK'});assert.equal(String(s.totalDebt),'0');assert.equal(String(s.creditBalance),'100000');assert.equal(s.nextCharge,null);
 const p=(await bearer('get','/tenant/payments',a.token).expect(200)).body;
 assert.equal(p.total,2,'only own payments');
 assert.equal(String(p.items[0].amount),'400000');assert.equal(String(p.items[0].allocations[0].amount),'300000');assert.equal(String(p.items[0].unallocatedAmount),'100000');
 assert.equal(p.items[0].allocations[0].charge.id,c.id);
 const json=JSON.stringify(p);
 for(const leak of ['Внутренняя заметка','Owner','comment','creator','idempotencyKey'])assert.ok(!json.includes(leak),leak+' is not exposed');
});

test('tenant finance is read-only, tenant-only and paged; checkout ends access',async()=>{
 const a=await tenant(1);
 for(const p of ['/tenant/finance','/tenant/charges','/tenant/payments']){
  await request(server).get('/api'+p).expect(401);
  await send(owner,'get',p).expect(401);
  await bearer('get',p,ownerToken).expect(401);
 }
 await bearer('get','/finance',a.token).expect(401);
 await bearer('post','/tenant/charges',a.token).send({}).expect(404);
 await bearer('post','/finance/payments',a.token).send({}).expect(401);
 await bearer('get','/tenant/charges?page=0',a.token).expect(422);
 await bearer('get','/tenant/charges?page=abc',a.token).expect(422);
 assert.deepEqual((await bearer('get','/tenant/charges?page=2',a.token).expect(200)).body.items,[]);
 const occupancy=await db.occupancy.findFirst({where:{residentId:a.resident.id,status:'ACTIVE'}});
 await send(owner,'post',`/occupancies/${occupancy.id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 await bearer('get','/tenant/finance',a.token).expect(401);
});

test('every payment has a receipt: number in the house sequence, what it paid, who accepted it and the balance right after',async()=>{
 const a=await tenant(1),b=await tenant(2);
 const c=await charge(a.resident);
 const p1=await pay(a.resident,'200000',{chargeId:c.id});
 const p2=await pay(b.resident,'50000',{method:'CARD_TRANSFER'});
 const p3=await pay(a.resident,'400000');
 // the tenant's list carries the receipt numbers
 const list=(await bearer('get','/tenant/payments',a.token).expect(200)).body.items;
 assert.deepEqual(list.map(p=>p.receiptNumber),[3,1]);
 // cash, part of the rent: debt left after it
 let r=(await bearer('get',`/tenant/payments/${p1.id}/receipt`,a.token).expect(200)).body;
 assert.equal(r.number,1);assert.equal(r.method,'CASH');assert.equal(String(r.amount),'200000');
 assert.equal(r.property.name,'Tenant finance');assert.deepEqual([r.resident.fullName,r.resident.room,r.resident.bed],['Tenant 1','1','2']);
 assert.equal(r.acceptedBy,'Owner','the receipt names who accepted the money');
 assert.equal(r.items.length,1);assert.equal(r.items[0].type,'RENT');assert.equal(String(r.items[0].amount),'200000');
 assert.equal(String(r.toCredit),'0');assert.deepEqual([String(r.after.debt),String(r.after.credit)],['300000','0']);
 assert.ok(!JSON.stringify(r).includes('Внутренняя заметка'),'the staff comment stays internal');
 // the rest of the rent plus an advance; a later payment does not change an earlier receipt
 r=(await bearer('get',`/tenant/payments/${p3.id}/receipt`,a.token).expect(200)).body;
 assert.equal(r.number,3);assert.equal(String(r.items[0].amount),'300000');assert.equal(String(r.toCredit),'100000');
 assert.deepEqual([String(r.after.debt),String(r.after.credit)],['0','100000']);
 assert.equal(String((await bearer('get',`/tenant/payments/${p1.id}/receipt`,a.token).expect(200)).body.after.debt),'300000');
 // an advance with nothing to pay still shows the resident's place
 r=(await bearer('get',`/tenant/payments/${p2.id}/receipt`,b.token).expect(200)).body;
 assert.deepEqual([r.number,r.method,r.items.length,String(r.toCredit),r.resident.bed],[2,'CARD_TRANSFER',0,'50000','3']);
 // someone else's receipt does not exist for this tenant; staff see every receipt
 await bearer('get',`/tenant/payments/${p2.id}/receipt`,a.token).expect(404);
 await bearer('get',`/tenant/payments/${randomUUID()}/receipt`,a.token).expect(404);
 await bearer('get','/tenant/payments/not-a-uuid/receipt',a.token).expect(400);
 await request(server).get(`/api/tenant/payments/${p1.id}/receipt`).expect(401);
 const staff=(await send(owner,'get',`/finance/payments/${p3.id}/receipt`).expect(200)).body;
 assert.equal(staff.number,3);assert.equal(staff.resident.fullName,'Tenant 1');
 await bearer('get',`/finance/payments/${p3.id}/receipt`,a.token).expect(401);
 const snap=(await send(owner,'get','/finance').expect(200)).body;
 assert.deepEqual(snap.payments.map(p=>p.receiptNumber),[3,2,1]);
});

test('the month report: charged, received by method and by who accepted it, rent by resident, debt now and every receipt',async()=>{
 const a=await tenant(1),b=await tenant(2);
 const month=day(0).slice(0,7);
 await charge(a.resident,{billingPeriodStart:`${month}-01`,billingPeriodEnd:day(0),dueDate:day(0)});
 await charge(b.resident,{billingPeriodStart:`${month}-01`,billingPeriodEnd:day(0),dueDate:day(0),amount:'600000'});
 await charge(a.resident,{billingPeriodStart:`${month}-01`,billingPeriodEnd:day(0),dueDate:day(0),amount:'100000',type:'UTILITIES'});
 await pay(a.resident,'600000');await pay(b.resident,'200000',{method:'BANK_TRANSFER'});
 const r=(await send(owner,'get','/finance/month-report').expect(200)).body;
 assert.equal(r.month,month);assert.equal(r.current,true);
 assert.equal(String(r.charged.total),'1200000');assert.equal(String(r.charged.byType.RENT),'1100000');assert.equal(String(r.charged.byType.UTILITIES),'100000');
 assert.equal(String(r.received.total),'800000');assert.equal(r.received.count,2);
 assert.deepEqual([String(r.received.byMethod.CASH),String(r.received.byMethod.BANK_TRANSFER)],['600000','200000']);
 assert.deepEqual(r.received.byStaff.map(s=>[s.name,String(s.total),String(s.cash),s.count]),[['Owner','800000','600000',2]]);
 assert.deepEqual([r.rent.paid.residents,r.rent.partial.residents,r.rent.unpaid.residents],[1,1,0]);
 assert.equal(String(r.rent.partial.amount),'400000');
 assert.equal(String(r.now.debt),'400000');
 assert.deepEqual(r.payments.map(p=>[p.receiptNumber,p.resident.fullName,p.acceptedBy]),[[2,'Tenant 2','Owner'],[1,'Tenant 1','Owner']]);
 // an earlier month is its own report; a future month and a bad month are refused; tenants have no access
 const prev=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7)-2,1)).toISOString().slice(0,7);
 const old=(await send(owner,'get',`/finance/month-report?month=${prev}`).expect(200)).body;
 assert.deepEqual([old.current,String(old.received.total),old.payments.length],[false,'0',0]);
 const next=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)).toISOString().slice(0,7);
 await send(owner,'get',`/finance/month-report?month=${next}`).expect(422);
 await send(owner,'get','/finance/month-report?month=2026-13').expect(422);
 await bearer('get','/finance/month-report',a.token).expect(401);
});
