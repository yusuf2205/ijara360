const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {randomUUID}=require('node:crypto');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Analytics test password 2026';
let app,server,owner,beds;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const ym=(offset)=>{const t=today();const d=new Date(Date.UTC(+t.slice(0,4),+t.slice(5,7)-1+offset,1));return d.toISOString().slice(0,7);};
const daysIn=(m)=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).getUTCDate();
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Analytics',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

async function stay(n,moveInDate,extra={}){
 const r=(await send(owner,'post','/residents').send({fullName:'Resident '+n,phone:'+99890400000'+n}).expect(201)).body;
 const o=(await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate,monthlyPrice:'500000',paymentDay:5,depositAmount:'0',...extra}).expect(201)).body;
 return {r,o};
}
const charge=(r,n,extra)=>send(owner,'post','/finance/charges').send({residentId:r.id,bedId:beds[n].id,amount:'500000',type:'RENT',idempotencyKey:randomUUID(),gracePeriodDays:0,...extra}).expect(201).then(x=>x.body);
const pay=(r,amount,extra={})=>send(owner,'post','/finance/payments').send({residentId:r.id,amount,method:'CASH',idempotencyKey:randomUUID(),...extra}).expect(201).then(x=>x.body);

test('analytics: occupancy by bed-nights, move-ins, charged vs received, on-time rent, debt, forecast and rooms',async()=>{
 const prev=ym(-1),cur=ym(0),d=+today().slice(8,10);
 // A since the first day of last month, B since the first day of this month; the third bed is new today.
 const a=await stay(0,`${prev}-01`),b=await stay(1,`${cur}-01`);
 // last month's rent paid late; this month's rent due today and paid now (on time); utilities left unpaid
 await charge(a.r,0,{billingPeriodStart:`${prev}-01`,billingPeriodEnd:`${prev}-${daysIn(prev)}`,dueDate:`${prev}-05`});
 await charge(b.r,1,{billingPeriodStart:`${cur}-01`,billingPeriodEnd:`${cur}-${daysIn(cur)}`,dueDate:today()});
 await pay(a.r,'500000');await pay(b.r,'500000',{method:'CARD_TRANSFER'});
 await charge(b.r,1,{amount:'100000',type:'UTILITIES',billingPeriodStart:`${cur}-01`,billingPeriodEnd:today(),dueDate:today()});
 await send(owner,'put',`/occupancies/${b.o.id}/plan`).send({plannedEndDate:today()}).expect(200);

 const x=(await send(owner,'get','/analytics').expect(200)).body;
 assert.equal(x.months.length,12);assert.equal(x.months[11].month,cur);assert.equal(x.months[11].current,true);
 const m=x.months[11],p=x.months[10];
 // this month: two beds taken all d days; the third bed exists only today
 assert.equal(m.occupancyPct,Math.round(2*d/(2*d+1)*1000)/10);
 assert.deepEqual([m.bedsOccupied,m.beds,m.moveIns,m.moveOuts],[2,3,1,0]);
 assert.deepEqual([m.charged,m.rentCharged,m.received],['600000.00','500000.00','1000000.00']);
 assert.equal(m.collected,'500000.00');assert.equal(m.collectionPct,83.3);
 assert.deepEqual([m.dueCount,m.onTime,m.onTimePct],[1,1,100]);
 assert.equal(m.debt,'100000.00');
 // last month: only A, every night of it; its rent was paid after the due date
 assert.deepEqual([p.month,p.occupancyPct,p.bedsOccupied,p.beds,p.moveIns],[prev,100,1,1,1]);
 assert.deepEqual([p.charged,p.received,p.collectionPct,p.dueCount,p.onTime,p.onTimePct],['500000.00','0.00',100,1,0,0]);
 assert.equal(p.debt,'0.00','charges entered today were not owed at the end of last month');
 // before anyone lived here: no occupancy figure, nothing charged
 assert.deepEqual([x.months[0].occupancyPct,x.months[0].charged,x.months[0].onTimePct],[null,'0.00',null]);

 assert.deepEqual([x.now.beds,x.now.occupied,x.now.free,x.now.avgPrice,x.now.lostPerMonth],[3,2,1,'500000.00','500000.00']);
 assert.deepEqual([x.now.forecast.month,x.now.forecast.rent,x.now.forecast.staying,x.now.forecast.leaving,x.now.forecast.leavingRent],[ym(1),'500000.00',1,1,'500000.00']);
 assert.deepEqual(x.now.endingIn30Days,{residents:1,rent:'500000.00'});
 assert.equal(x.now.avgStayDays,null);
 assert.deepEqual([x.window.received,x.window.charged,x.window.collected,x.window.collectionPct],['1000000.00','1100000.00','1000000.00',90.9]);
 assert.deepEqual(x.window.methods.map(w=>[w.method,w.amount,w.count]).sort(),[['CARD_TRANSFER','500000.00',1],['CASH','500000.00',1]]);
 assert.equal(x.rooms.length,1);
 assert.deepEqual([x.rooms[0].number,x.rooms[0].beds,x.rooms[0].occupied,x.rooms[0].received],['1',3,2,'1000000.00']);

 // a finished stay gives the average length of stay
 await send(owner,'post',`/occupancies/${a.o.id}/check-out`).send({moveOutDate:today()}).expect(201);
 const y=(await send(owner,'get','/analytics?months=3').expect(200)).body;
 assert.equal(y.months.length,3);
 const prevStart=new Date(`${prev}-01T00:00:00Z`),now=new Date(`${today()}T00:00:00Z`);
 assert.equal(y.now.avgStayDays,Math.round((now-prevStart)/86400000));assert.equal(y.now.closedStays,1);
 assert.deepEqual([y.months[2].moveOuts,y.now.occupied,y.now.free],[1,1,2]);
});

test('analytics is for staff who see finance; ranges are checked',async()=>{
 await send(owner,'get','/analytics?months=2').expect(422);
 await send(owner,'get','/analytics?months=25').expect(422);
 await send(owner,'get','/analytics?months=abc').expect(422);
 await request(server).get('/api/analytics').expect(401);
 const x=(await send(owner,'get','/analytics?months=24').expect(200)).body;
 assert.equal(x.months.length,24);assert.equal(x.now.beds,3);assert.equal(x.now.free,3);assert.equal(x.now.lostPerMonth,'0.00','no prices yet, so no estimate');
});
