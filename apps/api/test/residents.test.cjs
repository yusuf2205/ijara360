const { test,before,after,beforeEach }=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test') throw Error('Dedicated test database required');
const db=new PrismaClient(); let app,server,agent,actor,beds;
const password='M2 test only long password 2026';
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',process.env.APP_ORIGIN).set('X-Ijara-Request','1');
const reset=()=>db.$executeRawUnsafe('TRUNCATE audit_logs, sessions, users, occupancies, residents, beds, rooms, properties, rate_buckets CASCADE');
const resident=(n=1)=>({fullName:'Resident '+n,phone:'+998901000'+String(n).padStart(3,'0')});
const create=async(n=1,a=agent)=>(await send(a,'post','/residents').send(resident(n)).expect(201)).body;
const body=(id,bed=beds[0].id)=>({residentId:id,bedId:bed,moveInDate:'2026-09-01',monthlyPrice:'750000.50',paymentDay:10,depositAmount:'100000'});
const checkin=async(id,bed=beds[0].id,a=agent)=>(await send(a,'post','/occupancies/check-in').send(body(id,bed)).expect(201)).body;
before(async()=>{app=await createApp();await app.init();server=app.getHttpServer();});
beforeEach(async()=>{
 await reset();
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'M2 test',rooms:[{number:'1',capacity:2},{number:'2',capacity:2}]}).expect(201);
 agent=request.agent(server);await send(agent,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);
 actor=(await send(agent,'get','/auth/me')).body;
 beds=await db.bed.findMany({orderBy:[{roomId:'asc'},{number:'asc'}]});
});
after(async()=>{await reset();await app.close();await db.$disconnect();});
test('resident create, normalized duplicate, edit, filters and phone search',async()=>{
 const r=await create();assert.equal(r.propertyId,actor.propertyId);
 await send(agent,'post','/residents').send({...resident(),phone:'+998 (90) 100-00-01'}).expect(409);
 await send(agent,'patch','/residents/'+r.id).send({...resident(),fullName:'Updated',note:'Note'}).expect(200);
 const found=(await send(agent,'get','/residents?q=90%20100')).body;assert.equal(found.length,1);
 assert.equal((await send(agent,'get','/residents?filter=closed')).body.length,0);
 await send(agent,'post','/residents').send({...resident(2),phone:'invalid'}).expect(422);
});
test('check-in updates real room and dashboard counters and detail',async()=>{
 const r=await create();const o=await checkin(r.id);
 assert.equal(o.status,'ACTIVE');assert.equal(o.monthlyPrice,'750000.5');
 const room=(await send(agent,'get','/rooms/'+o.roomId)).body;
 assert.equal(room.occupiedBeds,1);assert.equal(room.availableBeds,1);assert.equal(room.beds.find(b=>b.id===o.bedId).occupancy.resident.id,r.id);
 const dash=(await send(agent,'get','/dashboard')).body;assert.equal(dash.occupiedBeds,1);assert.equal(dash.availableBeds,3);assert.equal(dash.currentResidents,1);
 assert.equal((await send(agent,'get','/residents?filter=active')).body.length,1);
});
test('occupied bed and already active resident yield distinct friendly conflicts',async()=>{
 const a=await create(),b=await create(2);await checkin(a.id);
 const full=await send(agent,'post','/occupancies/check-in').send(body(b.id)).expect(409);assert.equal(full.body.message,'Это место уже занято');
 const active=await send(agent,'post','/occupancies/check-in').send(body(a.id,beds[1].id)).expect(409);assert.equal(active.body.message,'Жилец уже проживает в доме');
});
test('two independent ADMIN sessions race for a bed: exactly one succeeds',async()=>{
 const admins=[];
 for(let n=2;n<4;n++){await send(agent,'post','/users').send({phone:'+99890000000'+n,fullName:'Admin '+n,password}).expect(201);const a=request.agent(server);await send(a,'post','/auth/login').send({phone:'+99890000000'+n,password}).expect(200);admins.push(a);}
 const a=await create(1,admins[0]),b=await create(2,admins[1]);
 const result=await Promise.all([a,b].map((r,i)=>send(admins[i],'post','/occupancies/check-in').send(body(r.id))));
 assert.deepEqual(result.map(r=>r.status).sort(),[201,409]);assert.equal(await db.occupancy.count({where:{status:'ACTIVE'}}),1);
 assert.equal(result.find(r=>r.status===409).body.message,'Это место уже занято');
});
test('same resident concurrent check-ins on different beds: exactly one succeeds',async()=>{
 const r=await create();const results=await Promise.all([0,1].map(i=>send(agent,'post','/occupancies/check-in').send(body(r.id,beds[i].id))));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});
test('transfer closes old history, preserves prices and moves occupancy to another room',async()=>{
 const r=await create();const old=await checkin(r.id);const target=beds.find(b=>b.roomId!==old.roomId);
 const next=(await send(agent,'post','/occupancies/'+old.id+'/transfer').send({bedId:target.id,transferDate:'2026-09-10'}).expect(201)).body;
 const detail=(await send(agent,'get','/residents/'+r.id)).body;
 assert.equal(detail.occupancies.length,2);assert.equal(next.status,'ACTIVE');assert.equal(next.monthlyPrice,old.monthlyPrice);assert.equal(next.depositAmount,old.depositAmount);
 const closed=await db.occupancy.findUnique({where:{id:old.id}});assert.equal(closed.status,'CLOSED');assert.equal(closed.bedId,old.bedId);
 assert.equal((await send(agent,'get','/rooms/'+old.roomId)).body.occupiedBeds,0);
});
test('checkout frees bed, rejects repeat, keeps history, resident can return',async()=>{
 const r=await create();const o=await checkin(r.id);
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(201);
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(409);
 assert.equal((await send(agent,'get','/dashboard')).body.occupiedBeds,0);assert.equal((await send(agent,'get','/residents?filter=closed')).body.length,1);
 await send(agent,'post','/occupancies/check-in').send({...body(r.id),moveInDate:'2026-09-11'}).expect(201);
 assert.equal(await db.resident.count(),1);assert.equal((await send(agent,'get','/residents/'+r.id)).body.occupancies.length,2);
});
test('foreign property IDs hidden for resident, bed, occupancy and list; DB composite FKs enforce scope',async()=>{
 const foreign=await db.property.create({data:{name:'Foreign'}});const foreignRoom=await db.room.create({data:{propertyId:foreign.id,number:'X',capacity:1}});const foreignBed=await db.bed.create({data:{roomId:foreignRoom.id,number:'1'}});
 const other=await db.resident.create({data:{...resident(8),propertyId:foreign.id}});const r=await create();
 await send(agent,'get','/residents/'+other.id).expect(404);await send(agent,'patch','/residents/'+other.id).send(resident(8)).expect(404);
 await send(agent,'post','/occupancies/check-in').send(body(other.id)).expect(404);await send(agent,'post','/occupancies/check-in').send(body(r.id,foreignBed.id)).expect(404);
 assert.equal((await send(agent,'get','/residents')).body.length,1);
 const o=await checkin(r.id);
 const raw={...o,id:undefined,createdAt:undefined,updatedAt:undefined,moveInDate:new Date(o.moveInDate),residentId:other.id,bedId:beds[1].id};
 await assert.rejects(db.occupancy.create({data:raw}));
 await db.occupancy.create({data:{propertyId:foreign.id,residentId:other.id,roomId:foreignRoom.id,bedId:foreignBed.id,createdBy:(await db.user.create({data:{propertyId:foreign.id,phone:'+998900000009',fullName:'Foreign',passwordHash:'not-used'}})).id,moveInDate:new Date('2026-09-01'),monthlyPrice:0,paymentDay:1,depositAmount:0}}).then(async otherO=>{
  await send(agent,'post','/occupancies/'+otherO.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(404);
  await send(agent,'post','/occupancies/'+otherO.id+'/transfer').send({bedId:beds[1].id,transferDate:'2026-09-10'}).expect(404);
 });
});
test('DB partial unique indexes stop concurrent direct writes on same bed and resident',async()=>{
 const a=await create(),b=await create(2);
 const data=r=>({propertyId:actor.propertyId,residentId:r.id,roomId:beds[0].roomId,bedId:beds[0].id,createdBy:actor.id,moveInDate:new Date('2026-09-01'),monthlyPrice:0,paymentDay:1,depositAmount:0});
 const race=await Promise.allSettled([a,b].map(r=>db.occupancy.create({data:data(r)})));assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 const winner=race.find(r=>r.status==='fulfilled').value;
 await assert.rejects(db.occupancy.create({data:{...data(a),residentId:winner.residentId,bedId:beds[1].id}}));
});
test('database rejects history rewrite, deletion, invalid state and negative price',async()=>{
 const r=await create();const o=await checkin(r.id);
 await assert.rejects(db.occupancy.update({where:{id:o.id},data:{bedId:beds[1].id}}));
 await assert.rejects(db.occupancy.delete({where:{id:o.id}}));
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(201);
 await assert.rejects(db.occupancy.update({where:{id:o.id},data:{status:'ACTIVE',moveOutDate:null}}));
 const data={propertyId:actor.propertyId,residentId:r.id,roomId:beds[0].roomId,bedId:beds[0].id,createdBy:actor.id,moveInDate:new Date('2026-09-11'),monthlyPrice:-1,paymentDay:1,depositAmount:0};
 await assert.rejects(db.occupancy.create({data}));await assert.rejects(db.occupancy.create({data:{...data,monthlyPrice:0,status:'CLOSED'}}));
});
test('date and money validation, no backdated overlap or transfer to current place',async()=>{
 const r=await create();
 for(const data of [{moveInDate:'2026-02-30'},{moveInDate:'2099-01-01'},{monthlyPrice:'-1'},{monthlyPrice:'1.001'},{paymentDay:32},{residentId:null,resident:null}]) await send(agent,'post','/occupancies/check-in').send({...body(r.id),...data}).expect(422);
 const o=await checkin(r.id);
 await send(agent,'post','/occupancies/'+o.id+'/transfer').send({bedId:o.bedId,transferDate:'2026-09-10'}).expect(409);
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-08-30'}).expect(422);
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(201);
 await send(agent,'post','/occupancies/check-in').send(body(r.id)).expect(409);
 const other=await create(2);await send(agent,'post','/occupancies/check-in').send(body(other.id)).expect(409);
});
test('audit is complete and contains identifiers, never resident phone or note',async()=>{
 const r=await create();await send(agent,'patch','/residents/'+r.id).send({...resident(),note:'Private note'}).expect(200);
 const o=await checkin(r.id);const next=(await send(agent,'post','/occupancies/'+o.id+'/transfer').send({bedId:beds[1].id,transferDate:'2026-09-10'})).body;
 await send(agent,'post','/occupancies/'+next.id+'/check-out').send({moveOutDate:'2026-09-11'}).expect(201);
 const audit=await db.auditLog.findMany({where:{entityId:r.id}});assert.equal(audit.length,5);
 const transfer=audit.find(x=>x.action==='OCCUPANCY_TRANSFERRED');assert.equal(transfer.actorId,actor.id);assert.equal(transfer.metadata.oldBedId,o.bedId);assert.equal(transfer.metadata.newBedId,next.bedId);
 assert.equal(JSON.stringify(audit).includes(r.phone),false);assert.equal(JSON.stringify(audit).includes('Private note'),false);
});
test('audit failure rolls back new resident, transfer and checkout atomically',async()=>{
 const r=await create();const o=await checkin(r.id);
 await db.$executeRawUnsafe("CREATE FUNCTION m2_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'OCCUPANCY_%' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$");
 await db.$executeRawUnsafe('CREATE TRIGGER m2_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION m2_fail_audit()');
 try {
  await send(agent,'post','/occupancies/check-in').send({...body(undefined,beds[1].id),resident:resident(2)}).expect(500);assert.equal(await db.resident.count(),1);
  await send(agent,'post','/occupancies/'+o.id+'/transfer').send({bedId:beds[1].id,transferDate:'2026-09-10'}).expect(500);
  await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-10'}).expect(500);
  assert.equal(await db.occupancy.count(),1);assert.equal((await db.occupancy.findUnique({where:{id:o.id}})).status,'ACTIVE');
 } finally {await db.$executeRawUnsafe('DROP TRIGGER m2_fail_audit ON audit_logs');await db.$executeRawUnsafe('DROP FUNCTION m2_fail_audit()');}
});
test('occupied destination transfer rolls back and stale checkout cannot close new stay',async()=>{
 const a=await create(),b=await create(2);const o=await checkin(a.id);await checkin(b.id,beds[1].id);
 await send(agent,'post','/occupancies/'+o.id+'/transfer').send({bedId:beds[1].id,transferDate:'2026-09-10'}).expect(409);
 assert.equal((await db.occupancy.findUnique({where:{id:o.id}})).status,'ACTIVE');
 const next=(await send(agent,'post','/occupancies/'+o.id+'/transfer').send({bedId:beds[2].id,transferDate:'2026-09-10'}).expect(201)).body;
 await send(agent,'post','/occupancies/'+o.id+'/check-out').send({moveOutDate:'2026-09-11'}).expect(409);
 assert.equal((await db.occupancy.findUnique({where:{id:next.id}})).status,'ACTIVE');
});
