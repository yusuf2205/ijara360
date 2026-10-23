const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const sharp=require('sharp');
const {randomBytes}=require('node:crypto');
const {WebSocket}=require('ws');
const {createApp}=require('../dist/app');
const {PhoneVerificationService}=require('../dist/phone-verification');
const {PERMISSIONS}=require('../dist/permission-policy');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='9'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Application test only password 2026';
let app,server,phoneService,owner,image,actor,room;
const send=(agent,method,path)=>agent[method](`/api${path}`).set('Origin',origin).set('X-Ijara-Request','1');
const profile={fullName:'Test Applicant',dateOfBirth:'2000-01-01',pinfl:'12345678901234',passportSeries:'AA',passportNumber:'1234567',occupationType:'STUDENT',organization:'Test university',requestedMoveInDate:'2026-10-01',plannedDuration:'12 months',emergencyName:'Test Contact',emergencyRelationship:'Parent',emergencyPhone:'+998900000055',consent:true};
before(async()=>{await grantRuntime(db);image=await sharp(randomBytes(640*640*3),{raw:{width:640,height:640,channels:3}}).png().toBuffer();app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();phoneService=app.get(PhoneVerificationService);phoneService.call=async()=>true;});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:'+998900000001',password,fullName:'Owner',propertyName:'Test',rooms:[{number:'1',capacity:3}]}).expect(201);owner=request.agent(server);await send(owner,'post','/auth/login').send({phone:'+998900000001',password}).expect(200);actor=await db.user.findFirst();room=await db.room.findFirst({include:{beds:true}});});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});
async function start(phone='+998900000022') {const agent=request.agent(server);await send(agent,'post','/public/applications').send({phone,channel:'WEB'}).expect(201);return agent;}
async function mine(agent){return (await send(agent,'get','/public/applications/me').expect(200)).body;}
async function verify(agent,userId=22,number='+998900000022'){
 const result=(await send(agent,'post','/public/applications/phone').expect(201)).body;
 const token=new URL(result.url).searchParams.get('start');
 await phoneService.handle({update_id:1,message:{from:{id:userId},chat:{id:userId,type:'private'},text:`/start ${token}`}});
 await phoneService.handle({update_id:2,message:{from:{id:userId},chat:{id:userId,type:'private'},contact:{user_id:userId,phone_number:number}}});
 assert.equal((await mine(agent)).phoneVerified,true);
}
async function complete(agent,patch={}){
 await send(agent,'patch','/public/applications/me').send({...profile,...patch,version:(await mine(agent)).version}).expect(200);
 for(const kind of ['PASSPORT_FRONT','PASSPORT_BACK','FACE'])await send(agent,'put',`/public/applications/documents/${kind}`).set('Content-Type','image/png').send(image).expect(200);
 if(patch.skipPassword!==true)await send(agent,'post','/public/applications/password').send({password:'Resident app password 1'}).expect(200);
}
async function submitted(){const agent=await start();await verify(agent);await complete(agent);const a=await mine(agent);await send(agent,'post','/public/applications/submit').send({version:a.version}).expect(201);return {agent,a:await mine(agent)};}
function review(a,status,extra={}){return send(owner,'post',`/applications/${a.id}/review`).send({version:a.version,status,...extra});}
async function approved(){let {agent,a}=await submitted();a=(await review(a,'UNDER_REVIEW').expect(201)).body;a=(await review(a,'APPROVED',{identityReviewed:true,documentsReviewed:true,faceQualityConfirmed:true}).expect(201)).body;return {agent,a};}
async function admin(rights=[]){const u=(await send(owner,'post','/users').send({phone:'+998900000002',password,fullName:'Admin'}).expect(201)).body;await send(owner,'put',`/permissions/users/${u.id}`).send({permissions:rights}).expect(200);const agent=request.agent(server);await send(agent,'post','/auth/login').send({phone:u.phone,password}).expect(200);return {agent,u};}
// Passport OCR tests run only where tesseract is installed (the API image), skipped on a bare dev machine.
let hasTesseract=false;try{require('node:child_process').execSync('tesseract --version',{stdio:'ignore'});hasTesseract=true;}catch{}
const mrzVal=c=>(c>='0'&&c<='9'?c.charCodeAt(0)-48:c>='A'&&c<='Z'?c.charCodeAt(0)-55:0);
const mrzCd=f=>{const w=[7,3,1];let s=0;for(let i=0;i<f.length;i++)s+=mrzVal(f[i])*w[i%3];return String(s%10);};
const mrzPad=(s,n)=>s.padEnd(n,'<').slice(0,n);
async function passportImage(){const doc='AB1234567',birth='950215';const l1=mrzPad('P<UZBALIYEV<<SARDOR',44);let l2=doc+mrzCd(doc)+'UZB'+birth+mrzCd(birth)+'M'+'330101'+mrzCd('330101')+mrzPad('',14);l2=mrzPad(l2,43)+'0';const esc=s=>s.replace(/</g,'&lt;');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="460"><rect width="100%" height="100%" fill="white"/><text x="40" y="200" font-family="DejaVu Sans Mono, monospace" font-size="64" letter-spacing="6" fill="black" xml:space="preserve">${esc(l1)}</text><text x="40" y="340" font-family="DejaVu Sans Mono, monospace" font-size="64" letter-spacing="6" fill="black" xml:space="preserve">${esc(l2)}</text></svg>`;return sharp(Buffer.from(svg)).png().toBuffer();}
// OCR fills the profile in the background after the upload responds, so the tests poll until it lands.
async function waitForPassportFill(agent,ms=15000){const end=Date.now()+ms;for(;;){const p=(await mine(agent)).profile;if(p.passportSeries==='AB')return p;if(Date.now()>end)throw Error('OCR did not fill passport fields in time');await new Promise(r=>setTimeout(r,250));}}

test('draft is encrypted and resumed by scoped cookie; applicant cannot forge role or access another draft',async()=>{
 const agent=await start();const a=await mine(agent);assert.equal(a.status,'DRAFT');assert.equal(await db.resident.count(),0);
 const raw=await db.rentalApplication.findUnique({where:{id:a.id}});assert.ok(!raw.profileCipher.includes('+998'));
 await send(agent,'patch','/public/applications/me').send({version:1,role:'SUPER_ADMIN'}).expect(422);
 const other=await start('+998900000023');assert.notEqual((await mine(other)).id,a.id);
 await send(other,'get',`/applications/${a.id}`).expect(401);
 await db.applicantSession.updateMany({data:{expiresAt:new Date(0)}});await send(agent,'get','/public/applications/me').expect(401);
});
test('phone requires own Telegram contact, correct number and unexpired challenge',async()=>{
 const agent=await start();const link=(await send(agent,'post','/public/applications/phone')).body.url;const token=new URL(link).searchParams.get('start');
 await phoneService.handle({update_id:1,message:{from:{id:22},chat:{id:22,type:'private'},text:`/start ${token}`}});
 for(const contact of [{user_id:99,phone_number:'+998900000022'},{user_id:22,phone_number:'+998900000099'}])await phoneService.handle({update_id:2,message:{from:{id:22},chat:{id:22,type:'private'},contact}});
 assert.equal((await mine(agent)).phoneVerified,false);
 await db.phoneChallenge.updateMany({data:{expiresAt:new Date(0)}});
 await phoneService.handle({update_id:3,message:{from:{id:22},chat:{id:22,type:'private'},contact:{user_id:22,phone_number:'+998900000022'}}});
 assert.equal((await mine(agent)).phoneVerified,false);await verify(agent);
});
test('short form: name, place of study or work, move-in date and photos are enough; optional fields must still be well-formed',async()=>{
 const agent=await start();await verify(agent);
 const short={fullName:'Short Form',organization:'Test university',requestedMoveInDate:'2026-11-01',consent:true};
 for(const kind of ['PASSPORT_FRONT','PASSPORT_BACK','FACE'])await send(agent,'put',`/public/applications/documents/${kind}`).set('Content-Type','image/png').send(image).expect(200);
 for(const missing of ['fullName','organization','requestedMoveInDate','consent']){
  const {[missing]:_,...rest}=short;await send(agent,'patch','/public/applications/me').send({...rest,[missing]:missing==='consent'?false:'',version:(await mine(agent)).version}).expect(200);
  await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(422);
 }
 await send(agent,'patch','/public/applications/me').send({...short,pinfl:'123',version:(await mine(agent)).version}).expect(200);
 await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(422);
 await send(agent,'patch','/public/applications/me').send({...short,pinfl:'',version:(await mine(agent)).version}).expect(200);
 await send(agent,'post','/public/applications/password').send({password:'Short form app pass'}).expect(200);
 await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(201);
 assert.equal((await mine(agent)).status,'SUBMITTED');
});
test('submit requires verification, fields and all images; invalid and duplicate uploads handled',async()=>{
 const agent=await start();await send(agent,'post','/public/applications/submit').send({version:1}).expect(422);
 await verify(agent);await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(422);
 await send(agent,'put','/public/applications/documents/FACE').set('Content-Type','image/png').send(Buffer.alloc(2000)).expect(422);
 await complete(agent);await send(agent,'put','/public/applications/documents/FACE').set('Content-Type','image/png').send(image).expect(200);
 assert.equal(await db.applicationDocument.count(),3);await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(201);
 const raw=await db.rentalApplication.findFirst();assert.ok(!raw.profileCipher.includes(profile.pinfl));
});
test('staff permissions redact passport, documents and biometric; owner cannot lose rights',async()=>{
 const {a}=await submitted();const {agent,u}=await admin(['APPLICATION_VIEW']);
 const detail=(await send(agent,'get',`/applications/${a.id}`).expect(200)).body;assert.equal(detail.profile.pinfl,undefined);assert.equal(detail.profile.emergencyPhone,undefined);assert.equal(detail.documents.length,0);
 await send(agent,'get',`/applications/${a.id}/documents/FACE`).expect(403);await send(agent,'get',`/applications/${a.id}/documents/PASSPORT_FRONT`).expect(403);
 await send(agent,'put',`/permissions/users/${u.id}`).send({permissions:PERMISSIONS}).expect(403);
 await send(owner,'put',`/permissions/users/${actor.id}`).send({permissions:[]}).expect(403);
 await send(owner,'get',`/applications/${a.id}/documents/FACE`).expect(200);
 assert.equal(await db.auditLog.count({where:{action:'BIOMETRIC_SOURCE_VIEWED',actorId:actor.id}}),1);
 assert.equal((await send(owner,'get',`/applications/${a.id}`)).body.profile.pinfl,profile.pinfl);
 await db.user.update({where:{id:actor.id},data:{role:'SUPER_ADMIN'}});await send(owner,'get',`/applications/${a.id}/documents/PASSPORT_FRONT`).expect(200);
});
test('needs-info resubmission, reject reason and terminal transitions',async()=>{
 let {agent,a}=await submitted();a=(await review(a,'UNDER_REVIEW').expect(201)).body;
 await review(a,'REJECTED').expect(422);await review(a,'NEEDS_INFO',{reason:'Clearer image required'}).expect(422);
 await review(a,'NEEDS_INFO',{reason:'Clearer image required',requiredFields:'Passport front'}).expect(201);
 assert.equal((await mine(agent)).feedback.requiredFields,'Passport front');
 await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(201);
 a=await mine(agent);a=(await review(a,'UNDER_REVIEW')).body;a=(await review(a,'REJECTED',{reason:'No vacancy'}).expect(201)).body;
 await review(a,'APPROVED').expect(409);assert.equal((await mine(agent)).status,'REJECTED');
});
test('two simultaneous approvals produce one transition',async()=>{
 let {a}=await submitted();a=(await review(a,'UNDER_REVIEW')).body;
 const results=await Promise.all([1,2].map(()=>review(a,'APPROVED',{identityReviewed:true,documentsReviewed:true,faceQualityConfirmed:true})));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(await db.auditLog.count({where:{action:'APPLICATION_APPROVED'}}),1);
});
test('conversion uses M2 atomically and rejects duplicate conversion',async()=>{
 const {a}=await approved();const payload={version:a.version,bedId:room.beds[0].id,moveInDate:'2026-01-01',monthlyPrice:'100.50',paymentDay:5,depositAmount:'20'};
 const results=await Promise.all([1,2].map(()=>send(owner,'post',`/applications/${a.id}/convert`).send(payload)));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(await db.resident.count(),1);assert.equal(await db.occupancy.count({where:{status:'ACTIVE'}}),1);
 const current=await db.rentalApplication.findUnique({where:{id:a.id}});assert.equal(current.status,'CONVERTED_TO_RESIDENT');assert.ok(current.residentId&&current.occupancyId);
 assert.equal(await db.auditLog.count({where:{action:'OCCUPANCY_CHECKED_IN'}}),1);
});
test('conversion rejects occupied and archived bed, preserves approval',async()=>{
 const {a}=await approved();const resident=await db.resident.create({data:{propertyId:actor.propertyId,fullName:'Existing',phone:'+998900000099'}});
 await db.occupancy.create({data:{propertyId:actor.propertyId,residentId:resident.id,roomId:room.id,bedId:room.beds[0].id,moveInDate:new Date('2026-01-01'),monthlyPrice:'10',paymentDay:1,depositAmount:'0',createdBy:actor.id}});
 await send(owner,'post',`/applications/${a.id}/convert`).send({version:a.version,bedId:room.beds[0].id,moveInDate:'2026-01-01',monthlyPrice:'10',paymentDay:1,depositAmount:'0'}).expect(409);
 assert.equal(await db.resident.count(),1);assert.equal((await db.rentalApplication.findUnique({where:{id:a.id}})).status,'APPROVED');
});
test('duplicate phone blocks another submitted application and PINFL requires explicit review',async()=>{
 await submitted();const same=await start();await verify(same,23);await complete(same);await send(same,'post','/public/applications/submit').send({version:(await mine(same)).version}).expect(409);
 const second=await start('+998900000024');await verify(second,24,'+998900000024');await complete(second);await send(second,'post','/public/applications/submit').send({version:(await mine(second)).version}).expect(201);
 let a=await mine(second);a=(await review(a,'UNDER_REVIEW')).body;await review(a,'APPROVED',{identityReviewed:true,documentsReviewed:true,faceQualityConfirmed:true}).expect(409);
 const detail=(await send(owner,'get',`/applications/${a.id}`)).body;assert.ok(detail.duplicates.applications.length);
});
test('property isolation, disabled staff and expired document session',async()=>{
 const {agent,a}=await submitted();const {agent:staff,u}=await admin(PERMISSIONS);await db.user.update({where:{id:u.id},data:{active:false}});await send(staff,'get',`/applications/${a.id}/documents/FACE`).expect(401);
 const foreign=await db.property.create({data:{name:'Other'}});
 // A separate foreign user avoids changing existing audit foreign keys.
 const {hashPassword}=require('../dist/security');const foreignUser=await db.user.create({data:{propertyId:foreign.id,fullName:'Foreign',phone:'+998900000088',passwordHash:await hashPassword(password),role:'OWNER'}});
 const foreignAgent=request.agent(server);await send(foreignAgent,'post','/auth/login').send({phone:foreignUser.phone,password});await send(foreignAgent,'get',`/applications/${a.id}`).expect(404);
 await db.applicantSession.updateMany({data:{expiresAt:new Date(0)}});await send(agent,'get','/public/applications/documents/FACE').expect(401);
});
test('audit failure rolls back conversion and produces no resident or occupancy',async()=>{
 const {a}=await approved();await db.$executeRawUnsafe("CREATE FUNCTION test_application_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='APPLICATION_CONVERTED_TO_RESIDENT' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$");
 await db.$executeRawUnsafe('CREATE TRIGGER test_application_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_application_audit()');
 try{await send(owner,'post',`/applications/${a.id}/convert`).send({version:a.version,bedId:room.beds[0].id,moveInDate:'2026-01-01',monthlyPrice:'10',paymentDay:1,depositAmount:'0'}).expect(500);assert.equal(await db.resident.count(),0);assert.equal(await db.occupancy.count(),0);assert.equal((await db.rentalApplication.findUnique({where:{id:a.id}})).status,'APPROVED');}
 finally{await db.$executeRawUnsafe('DROP TRIGGER test_application_audit ON audit_logs');await db.$executeRawUnsafe('DROP FUNCTION test_application_audit()');}
});
test('authenticated WebSocket emits submitted only after commit; staff without application rights get no application events',async()=>{
 const login=await send(owner,'post','/auth/login').send({phone:'+998900000001',password});const cookie=login.headers['set-cookie'][0].split(';')[0];
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/events`,{headers:{Origin:origin,Cookie:cookie}});
 await new Promise((resolve,reject)=>{ws.once('message',resolve);ws.once('error',reject);});
 const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No submitted event')),5000);ws.on('message',async raw=>{const event=JSON.parse(raw);if(event.topic==='applications'&&event.type==='submitted'){clearTimeout(timer);assert.deepEqual(Object.keys(event).sort(),['id','topic','type']);const stored=await db.rentalApplication.findUnique({where:{id:event.id}});assert.equal(stored.status,'SUBMITTED');resolve();}});});
 const {agent}=await admin();const result=await send(agent,'post','/auth/login').send({phone:'+998900000002',password});
 const other=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/events`,{headers:{Origin:origin,Cookie:result.headers['set-cookie'][0].split(';')[0]}});
 const seen=[];await new Promise((resolve,reject)=>{other.once('message',resolve);other.once('error',reject);});other.on('message',raw=>seen.push(JSON.parse(raw)));
 await submitted();await received;await new Promise(r=>setTimeout(r,300));ws.close();other.close();
 assert.equal(seen.filter(e=>e.topic==='applications').length,0,'no application events without APPLICATION_VIEW');
});
test('approved-today filter keeps converted approvals and ignores other statuses',async()=>{
 let {a}=await approved();
 const list=q=>send(owner,'get',`/applications?${q}`).expect(200).then(r=>r.body);
 assert.deepEqual((await list('status=APPROVED&today=1')).items.map(i=>i.id),[a.id]);
 await send(owner,'post',`/applications/${a.id}/convert`).send({version:a.version,bedId:room.beds[0].id,moveInDate:'2026-01-01',monthlyPrice:'10',paymentDay:1,depositAmount:'0'}).expect(201);
 assert.equal((await list('status=APPROVED')).total,0);
 const today=await list('status=APPROVED&today=1');assert.equal(today.total,1);assert.equal(today.approvedToday,1);assert.equal(today.items[0].status,'CONVERTED_TO_RESIDENT');
 assert.equal((await list('status=SUBMITTED&today=1')).total,0);
});

test('a submitted application notifies staff who may view applications, without the applicant data',async()=>{
 const {a}=await submitted();
 const feed=(await send(owner,'get','/notifications').expect(200)).body;
 assert.equal(feed.items[0].title,'Новая заявка на проживание');assert.equal(feed.items[0].link,`/applications/${a.id}`);
 const text=JSON.stringify(feed);for(const pii of ['Test Applicant','900000022','12345678901234','1234567'])assert.ok(!text.includes(pii),'no applicant data in notifications');
 const {agent:viewer}=await admin(['APPLICATION_VIEW']);assert.equal((await send(viewer,'get','/notifications').expect(200)).body.total,0,'only staff who existed at submit time are notified');
});

test('the applicant sets their own password; submit needs it and the converted resident signs in with phone + password',async()=>{
 const agent=await start();await verify(agent);
 await send(agent,'patch','/public/applications/me').send({...profile,version:(await mine(agent)).version}).expect(200);
 for(const kind of ['PASSPORT_FRONT','PASSPORT_BACK','FACE'])await send(agent,'put',`/public/applications/documents/${kind}`).set('Content-Type','image/png').send(image).expect(200);
 // no password yet → submit refused
 await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(422);
 await send(agent,'post','/public/applications/password').send({password:'short'}).expect(422);
 await send(agent,'post','/public/applications/password').send({password:'My own app pass 1'}).expect(200);
 assert.equal((await mine(agent)).hasPassword,true);
 let a=(await send(agent,'post','/public/applications/submit').send({version:(await mine(agent)).version}).expect(201)).body;
 a=(await review(a,'UNDER_REVIEW').expect(201)).body;
 a=(await review(a,'APPROVED',{identityReviewed:true,documentsReviewed:true,faceQualityConfirmed:true}).expect(201)).body;
 const room=await db.room.findFirst({include:{beds:true}});
 await send(owner,'post',`/applications/${a.id}/convert`).send({version:a.version,bedId:room.beds[0].id,moveInDate:'2026-09-01',monthlyPrice:'500000',paymentDay:5,depositAmount:'0'}).expect(201);
 // the resident can log in immediately with their phone and the password they chose — no invite needed
 const phone='+998900000022';
 const login=await send(request(server),'post','/tenant/auth/login').send({phone,password:'My own app pass 1'}).expect(200);
 assert.ok(login.body.token||login.headers['set-cookie']);
});
test('passport upload reads the MRZ and fills empty fields in the background',{skip:hasTesseract?false:'tesseract not installed'},async()=>{
 process.env.OCR_IN_TEST='1';
 try{
  const agent=await start();await verify(agent);
  await send(agent,'put','/public/applications/documents/PASSPORT_FRONT').set('Content-Type','image/png').send(await passportImage()).expect(200);
  const p=await waitForPassportFill(agent);
  assert.equal(p.passportSeries,'AB');
  assert.equal(p.passportNumber,'1234567');
  assert.equal(p.dateOfBirth,'1995-02-15');
  assert.match(p.fullName,/Aliyev/);
 }finally{delete process.env.OCR_IN_TEST;}
});
test('passport OCR never overwrites a name the applicant already typed',{skip:hasTesseract?false:'tesseract not installed'},async()=>{
 process.env.OCR_IN_TEST='1';
 try{
  const agent=await start();await verify(agent);
  await send(agent,'patch','/public/applications/me').send({fullName:'Введённое Имя',version:(await mine(agent)).version}).expect(200);
  await send(agent,'put','/public/applications/documents/PASSPORT_FRONT').set('Content-Type','image/png').send(await passportImage()).expect(200);
  const p=await waitForPassportFill(agent); // passport fields get filled...
  assert.equal(p.fullName,'Введённое Имя'); // ...but the typed name is kept
 }finally{delete process.env.OCR_IN_TEST;}
});
test('a dark or blurry/blank photo is rejected; a clear one is accepted',async()=>{
 const agent=await start();await verify(agent);
 const dark=await sharp({create:{width:1200,height:800,channels:3,background:{r:12,g:12,b:14}}}).png().toBuffer();
 await send(agent,'put','/public/applications/documents/PASSPORT_FRONT').set('Content-Type','image/png').send(dark).expect(422);
 const flat=await sharp({create:{width:1200,height:800,channels:3,background:{r:150,g:150,b:150}}}).png().toBuffer();
 await send(agent,'put','/public/applications/documents/FACE').set('Content-Type','image/png').send(flat).expect(422);
 await send(agent,'put','/public/applications/documents/PASSPORT_FRONT').set('Content-Type','image/png').send(image).expect(200); // detailed photo passes
});
