const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {WebSocket}=require('ws');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService}=require('../dist/telegram');
const {LocationService,statusOf,locationPolicy}=require('../dist/location');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Location test password 2026';
let app,server,owner,ownerCookie,beds,location;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const bearer=(m,p,t)=>request(server)[m]('/api'+p).set('Authorization','Bearer '+t).set('X-Ijara-Request','1');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const day=(offset)=>{const t=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return new Date(new Date(t+'T00:00:00Z').getTime()+offset*86400000).toISOString().slice(0,10);};
const ago=s=>new Date(Date.now()-s*1000).toISOString();
// Distinctive coordinates, so a leak into the logs is easy to spot.
const LAT=41.311081,LON=69.240562;
const point=(seq,extra={})=>({latitude:LAT,longitude:LON,accuracyMeters:12.5,recordedAt:new Date().toISOString(),sequence:seq,...extra});
const okState={permission:'ALWAYS',servicesEnabled:true,background:'ALLOWED'};
// Everything the API prints during this file, to prove no coordinate reaches the logs.
let printed='';const write=process.stdout.write.bind(process.stdout),ewrite=process.stderr.write.bind(process.stderr);
process.stdout.write=(c,...a)=>{printed+=String(c);return write(c,...a);};process.stderr.write=(c,...a)=>{printed+=String(c);return ewrite(c,...a);};

before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();app.get(TelegramService).call=async()=>true;location=app.get(LocationService);});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Location',rooms:[{number:'1',capacity:3}]}).expect(201);
 owner=request.agent(server);const login=await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);ownerCookie=login.headers['set-cookie'][0].split(';')[0];
 beds=await db.bed.findMany({orderBy:{number:'asc'}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();
 assert.ok(!printed.includes('41.311')&&!printed.includes('69.240'),'coordinates never reach the API logs');});

async function tenant(n){
 const phone='+99890300000'+n;
 const r=(await send(owner,'post','/residents').send({fullName:'Жилец '+n,phone}).expect(201)).body;
 const occ=(await send(owner,'post','/occupancies/check-in').send({residentId:r.id,bedId:beds[n].id,moveInDate:day(-5),monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201)).body;
 const link=(await send(owner,'post',`/residents/${r.id}/app-invite`).send({channel:'LINK'}).expect(200)).body.link;
 await send(request(server),'post','/tenant/invites/accept').send({token:new URL(link).hash.slice(1),password:'Tenant own password 1'}).expect(200);
 const login=()=>request(server).post('/api/tenant/auth/login').set('X-Ijara-Request','1').send({phone,password:'Tenant own password 1',platform:'ANDROID',deviceName:'Phone '+n}).expect(200).then(x=>x.body.token);
 return {resident:r,occupancy:occ.id??occ.occupancy?.id,token:await login(),login};
}
async function admin(rights){
 const u=(await send(owner,'post','/users').send({phone:'+998900000002',password,fullName:'Admin'}).expect(201)).body;
 await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:rights}).expect(200);
 const a=request.agent(server);const l=await send(a,'post','/auth/login').send({phone:u.phone,password}).expect(200);
 return {agent:a,cookie:l.headers['set-cookie'][0].split(';')[0],user:u};
}
const share=t=>bearer('post','/tenant/location/consent',t.token).send({enabled:true}).expect(200);
const upload=(t,points,state=okState)=>bearer('post','/tenant/location',t.token).send({points,state});
function open(path,headers){
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`,{headers});const events=[];
 return new Promise((resolve,reject)=>{ws.once('error',reject);ws.once('message',()=>{ws.on('message',raw=>events.push(JSON.parse(raw)));resolve({ws,events});});});
}
const until=async(events,pred,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(events.some(pred))return true;await sleep(50);}return false;};

test('a tenant shares, uploads a point, and staff see it LIVE with accuracy; current and history are both stored',async()=>{
 const a=await tenant(1);
 assert.equal((await bearer('get','/tenant/location',a.token).expect(200)).body.status,'LOCATION_DISABLED');
 await upload(a,[point(1)]).expect(409);
 await share(a);
 const r=(await upload(a,[point(1)]).expect(200)).body;
 assert.deepEqual({accepted:r.accepted,duplicates:r.duplicates,rejected:r.rejected,status:r.status},{accepted:1,duplicates:0,rejected:0,status:'LIVE'});
 const me=(await bearer('get','/tenant/location',a.token).expect(200)).body;
 assert.equal(me.thisDeviceIsPrimary,true);assert.equal(me.primaryDevice,'Phone 1');assert.equal(me.accuracyMeters,12.5);
 const list=(await send(owner,'get','/locations').expect(200)).body;
 assert.deepEqual(list.counts,{ALL:1,LIVE:1,STALE:0,OFFLINE:0,LOCATION_DISABLED:0});
 const it=list.items[0];
 assert.equal(it.status,'LIVE');assert.equal(it.position.latitude,LAT);assert.equal(it.position.accuracy,12.5);assert.equal(it.position.current,true);
 assert.equal(it.room,'1');assert.equal(it.bed,'2');
 assert.equal(await db.residentLocationPoint.count(),1);
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).latitude,LAT);
});

test('anonymous, staff and a tenant naming another resident cannot upload; the session decides whose point it is',async()=>{
 const a=await tenant(1),b=await tenant(2);await share(a);await share(b);
 await request(server).post('/api/tenant/location').set('X-Ijara-Request','1').send({points:[point(1)]}).expect(401);
 await send(owner,'post','/tenant/location').send({points:[point(1)]}).expect(401);
 // An extra residentId is refused by validation (422); it can never pick whose point this is.
 await bearer('post','/tenant/location',a.token).send({points:[point(1)],residentId:b.resident.id}).expect(422);
 await upload(a,[point(5)]).expect(200);
 assert.equal(await db.residentLocationPoint.count({where:{residentId:b.resident.id}}),0);
 assert.equal(await db.residentLocationPoint.count({where:{residentId:a.resident.id}}),1);
 // A tenant reads only their own state; staff routes are closed to tenants.
 await bearer('get','/locations',a.token).expect(401);
 await bearer('get',`/residents/${b.resident.id}/location`,a.token).expect(401);
});

test('malformed and impossible points are rejected; future and too-old timestamps are dropped, not stored',async()=>{
 const a=await tenant(1);await share(a);
 for(const bad of [{latitude:91},{longitude:-181},{accuracyMeters:0},{recordedAt:'yesterday'},{sequence:-1},{latitude:'41'}])await upload(a,[point(1,bad)]).expect(422);
 await bearer('post','/tenant/location',a.token).send({points:Array.from({length:101},(_,i)=>point(i))}).expect(422);
 const r=(await upload(a,[point(1,{recordedAt:new Date(Date.now()+3600000).toISOString()}),point(2,{recordedAt:ago(80*3600)}),point(3,{accuracyMeters:9000}),point(4)]).expect(200)).body;
 assert.deepEqual({accepted:r.accepted,rejected:r.rejected},{accepted:1,rejected:3});
 // A jump of ~1000 km in 10 seconds is a glitch.
 const glitch=(await upload(a,[point(5,{latitude:50,recordedAt:new Date(Date.now()+10000).toISOString()})]).expect(200)).body;
 assert.equal(glitch.rejected,1);
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).latitude,LAT);
});

test('redelivery is deduplicated; an older buffered point goes to history but never replaces the newer current one',async()=>{
 const a=await tenant(1);await share(a);
 const now=point(10,{latitude:LAT+0.001});
 await upload(a,[now]).expect(200);
 const again=(await upload(a,[now]).expect(200)).body;
 assert.deepEqual({accepted:again.accepted,duplicates:again.duplicates},{accepted:0,duplicates:1});
 const batch=(await upload(a,[point(7,{recordedAt:ago(600)}),point(8,{recordedAt:ago(300)}),point(9,{recordedAt:ago(120)})]).expect(200)).body;
 assert.equal(batch.accepted,3);
 const cur=await db.residentLocation.findUnique({where:{residentId:a.resident.id}});
 assert.equal(cur.latitude,LAT+0.001,'the newest point stays current');
 assert.equal(await db.residentLocationPoint.count(),4);
});

test('status engine: LIVE → STALE → OFFLINE by time, LOCATION_DISABLED from the device, OFFLINE → LIVE on a fresh point',async()=>{
 const live=locationPolicy.liveSeconds,stale=locationPolicy.staleSeconds;
 const base={sharingEnabled:true,permissionState:'ALWAYS',servicesEnabled:true};
 const at=s=>new Date(Date.now()-s*1000);
 assert.equal(statusOf({...base,recordedAt:at(10),lastSeenAt:at(10)}).status,'LIVE');
 assert.equal(statusOf({...base,recordedAt:at(live+5),lastSeenAt:at(live+5)}).status,'STALE');
 assert.equal(statusOf({...base,recordedAt:at(stale+5),lastSeenAt:at(stale+5)}).status,'OFFLINE');
 assert.deepEqual(statusOf({...base,permissionState:'DENIED',recordedAt:at(10),lastSeenAt:at(5)}),{status:'LOCATION_DISABLED',reason:'PERMISSION_DENIED'});
 assert.deepEqual(statusOf({...base,servicesEnabled:false,recordedAt:at(10),lastSeenAt:at(5)}),{status:'LOCATION_DISABLED',reason:'SERVICES_OFF'});
 assert.equal(statusOf({...base,servicesEnabled:false,recordedAt:at(stale+60),lastSeenAt:at(stale+60)}).status,'OFFLINE','a silent device is OFFLINE, not DISABLED');
 assert.equal(statusOf({...base,sharingEnabled:false,recordedAt:at(10),lastSeenAt:at(10)}).status,'LOCATION_DISABLED');

 // The worker moves rows by time even with no new points, and a fresh point brings OFFLINE back to LIVE.
 const a=await tenant(1);await share(a);await upload(a,[point(1)]).expect(200);
 await db.residentLocation.update({where:{residentId:a.resident.id},data:{recordedAt:at(live+30),lastSeenAt:at(live+30)}});
 await location.refreshStatuses();
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).status,'STALE');
 await db.residentLocation.update({where:{residentId:a.resident.id},data:{recordedAt:at(stale+30),lastSeenAt:at(stale+30)}});
 await location.refreshStatuses();
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).status,'OFFLINE');
 await upload(a,[point(2)]).expect(200);
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).status,'LIVE');
 // Telemetry only (no point): the phone says location services are off.
 await upload(a,[],{permission:'ALWAYS',servicesEnabled:false,background:'ALLOWED'}).expect(200);
 const row=await db.residentLocation.findUnique({where:{residentId:a.resident.id}});
 assert.deepEqual([row.status,row.statusReason],['LOCATION_DISABLED','SERVICES_OFF']);
});

test('VIEW_LOCATION and VIEW_LOCATION_HISTORY are enforced by the API; owners always see; views are audited without coordinates',async()=>{
 const a=await tenant(1);await share(a);await upload(a,[point(1)]).expect(200);
 const none=await admin(['RESIDENTS_MANAGE']);
 for(const p of ['/locations',`/residents/${a.resident.id}/location`,`/residents/${a.resident.id}/location/history?from=${ago(3600)}&to=${new Date().toISOString()}`,'/map/config'])await send(none.agent,'get',p).expect(403);
 await send(owner,'put',`/permissions/users/${none.user.id}`).send({permissions:['VIEW_LOCATION']}).expect(200);
 await send(none.agent,'get','/locations').expect(200);
 await send(none.agent,'get',`/residents/${a.resident.id}/location`).expect(200);
 await send(none.agent,'get',`/residents/${a.resident.id}/location/history?from=${ago(3600)}&to=${new Date().toISOString()}`).expect(403);
 await send(owner,'put',`/permissions/users/${none.user.id}`).send({permissions:['VIEW_LOCATION','VIEW_LOCATION_HISTORY']}).expect(200);
 const h=(await send(none.agent,'get',`/residents/${a.resident.id}/location/history?from=${ago(3600)}&to=${new Date(Date.now()+60000).toISOString()}`).expect(200)).body;
 assert.equal(h.points.length,1);assert.equal(h.retentionDays,30);
 await send(none.agent,'get',`/residents/${a.resident.id}/location/history?from=${ago(40*86400)}&to=${new Date().toISOString()}`).expect(409);
 const audit=await db.auditLog.findMany({where:{action:{in:['RESIDENT_LOCATION_VIEWED','RESIDENT_LOCATION_HISTORY_VIEWED','PERMISSION_GRANTED']}}});
 assert.ok(audit.some(x=>x.action==='RESIDENT_LOCATION_HISTORY_VIEWED'));
 assert.ok(audit.some(x=>x.action==='PERMISSION_GRANTED'&&x.metadata.permission==='VIEW_LOCATION'));
 const all=JSON.stringify(await db.auditLog.findMany());
 assert.ok(!all.includes('41.31')&&!all.includes('69.24'),'no coordinates in the audit log');
 assert.equal((await send(owner,'get','/map/config').expect(200)).body.provider,null,'no key configured here');
});

test('another property cannot see or enumerate this resident',async()=>{
 const a=await tenant(1);await share(a);await upload(a,[point(1)]).expect(200);
 const p2=await db.property.create({data:{name:'Other'}});
 const {hashPassword}=require('../dist/security');
 await db.user.create({data:{propertyId:p2.id,phone:'+998900000099',fullName:'Other owner',passwordHash:await hashPassword(password),role:'OWNER'}});
 const other=request.agent(server);await send(other,'post','/auth/login').send({phone:'+998900000099',password}).expect(200);
 assert.equal((await send(other,'get','/locations').expect(200)).body.items.length,0);
 await send(other,'get',`/residents/${a.resident.id}/location`).expect(404);
 await send(other,'get',`/residents/${a.resident.id}/location/history?from=${ago(3600)}&to=${new Date().toISOString()}`).expect(404);
});

test('one primary phone: a second device is refused until the resident chooses it; a revoked session stops uploading',async()=>{
 const a=await tenant(1);await share(a);
 const second=await a.login();
 const r=await bearer('post','/tenant/location',second).send({points:[point(1)],state:okState}).expect(409);
 assert.equal(r.body.code,'NOT_PRIMARY');
 await bearer('post','/tenant/location/consent',second).send({enabled:true}).expect(200);
 await upload(a,[point(2)]).expect(409);
 await bearer('post','/tenant/location',second).send({points:[point(3)],state:okState}).expect(200);
 const sessions=(await bearer('get','/tenant/sessions',second).expect(200)).body;
 const current=sessions.find(s=>s.current);
 await bearer('delete',`/tenant/sessions/${current.id}`,a.token).expect(200);
 await bearer('post','/tenant/location',second).send({points:[point(4)],state:okState}).expect(401);
 // Turning sharing off stops collection and is shown as disabled, not offline.
 await bearer('post','/tenant/location/consent',a.token).send({enabled:false}).expect(200);
 assert.equal((await send(owner,'get','/locations').expect(200)).body.items[0].status,'LOCATION_DISABLED');
});

test('checkout stops tracking: uploads are refused, the current position goes, history stays until retention',async()=>{
 const a=await tenant(1);await share(a);await upload(a,[point(1)]).expect(200);
 await send(owner,'post',`/occupancies/${(await db.occupancy.findFirst({where:{residentId:a.resident.id}})).id}/check-out`).send({moveOutDate:day(0)}).expect(201);
 const r=await bearer('post','/tenant/location',a.token).send({points:[point(2)],state:okState});
 assert.ok([401,409].includes(r.status),'a moved-out tenant cannot upload');
 await location.refreshStatuses();
 assert.equal(await db.residentLocation.count(),0);
 assert.equal(await db.residentLocationPoint.count(),1);
 assert.ok(await db.auditLog.findFirst({where:{action:'LOCATION_STOPPED_AT_CHECKOUT'}}));
});

test('retention deletes history older than the policy, keeps the current position, audits only a count',async()=>{
 const a=await tenant(1);await share(a);await upload(a,[point(1)]).expect(200);
 await db.residentLocationPoint.create({data:{residentId:a.resident.id,propertyId:a.resident.propertyId,sessionId:'00000000-0000-4000-8000-000000000001',sequence:99n,latitude:LAT,longitude:LON,accuracyM:10,recordedAt:new Date(Date.now()-31*86400000)}});
 assert.equal(await location.retention(),1);
 assert.equal(await db.residentLocationPoint.count(),1);
 assert.equal((await db.residentLocation.findUnique({where:{residentId:a.resident.id}})).latitude,LAT);
 const purge=await db.auditLog.findFirst({where:{action:'LOCATION_HISTORY_PURGED'}});
 assert.deepEqual(purge.metadata,{points:1,olderThanDays:30});
});

test('realtime after commit: staff with VIEW_LOCATION get marker moves; staff without it get nothing; revoking stops events',async()=>{
 const a=await tenant(1);await share(a);
 const viewer=await admin(['VIEW_LOCATION']);
 const ownerWs=await open('/api/events',{cookie:ownerCookie,origin});
 const viewerWs=await open('/api/events',{cookie:viewer.cookie,origin});
 const blind=await (async()=>{await send(owner,'post','/users').send({phone:'+998900000003',password,fullName:'Blind'}).expect(201);const b=request.agent(server);const l=await send(b,'post','/auth/login').send({phone:'+998900000003',password}).expect(200);return open('/api/events',{cookie:l.headers['set-cookie'][0].split(';')[0],origin});})();
 const tenantWs=await open('/api/tenant/events',{authorization:'Bearer '+a.token});
 await upload(a,[point(1)]).expect(200);
 const moved=e=>e.topic==='location'&&e.data&&e.data.residentId===a.resident.id&&e.data.latitude===LAT;
 assert.ok(await until(ownerWs.events,moved),'owner gets the move');
 assert.ok(await until(viewerWs.events,moved),'VIEW_LOCATION gets the move');
 assert.ok(await until(tenantWs.events,moved),'the tenant gets their own update');
 await sleep(300);
 assert.ok(!blind.events.some(e=>e.topic==='location'),'no location events without the permission');
 // A rolled-back upload (another resident's lock is irrelevant here: invalid sequence) publishes nothing.
 const before=ownerWs.events.length;
 await upload(a,[point(1,{latitude:'x'})]).expect(422);await sleep(300);
 assert.equal(ownerWs.events.length,before);
 // Revoke VIEW_LOCATION: the hub re-reads grants every 5 s, after that no more location events.
 await send(owner,'put',`/permissions/users/${viewer.user.id}`).send({permissions:[]}).expect(200);
 assert.ok(await until(viewerWs.events,e=>e.type==='permissions.changed',8000));
 const count=viewerWs.events.filter(e=>e.topic==='location').length;
 await upload(a,[point(2,{latitude:LAT+0.0005})]).expect(200);
 assert.ok(await until(ownerWs.events,e=>e.topic==='location'&&e.data&&Math.abs(e.data.latitude-(LAT+0.0005))<1e-9));
 await sleep(300);
 assert.equal(viewerWs.events.filter(e=>e.topic==='location').length,count);
 for(const s of [ownerWs,viewerWs,blind,tenantWs])s.ws.close();
});

test('rate limit stops a runaway client without blocking normal reconnect batches',async()=>{
 const a=await tenant(1);await share(a);
 // A full 100-point buffer is one request.
 const buffer=Array.from({length:100},(_,i)=>point(i+1,{recordedAt:ago(3600-i*30)}));
 assert.equal((await upload(a,buffer).expect(200)).body.accepted,100);
 let limited=false;
 for(let i=0;i<260&&!limited;i++){const r=await upload(a,[],okState);if(r.status===429)limited=true;}
 assert.ok(limited,'a client hammering the endpoint is limited');
});
