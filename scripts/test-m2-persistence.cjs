const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
const origin='http://100.126.164.29:3187'; // fixed isolated test gateway, never production
const base=origin+'/api';
const state='.local/m2-persistence.json';
let cookie;
async function call(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:'http://localhost:3000','X-Ijara-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(path+': '+r.status);if(path==='/auth/login')cookie=r.headers.get('set-cookie').split(';')[0];return r.json();}
(async()=>{
 if(process.argv[2]==='before'){
  await call('/auth/login',{phone:'+998900000010',password:'UI test only strong password 2026'});
  const rooms=await call('/rooms');const bed=rooms.flatMap(r=>r.beds).find(b=>b.status==='AVAILABLE');
  const targetRoom=rooms.find(r=>r.id!==bed?.roomId&&r.beds.some(b=>b.status==='AVAILABLE'));
  const target=targetRoom?.beds.find(b=>b.status==='AVAILABLE');
  assert.ok(bed&&target,'Two free beds in different test rooms required');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const resident=await call('/residents',{fullName:'TEST M2 restart '+Date.now(),phone:'+998'+String(Date.now()).slice(-9)});
  const old=await call('/occupancies/check-in',{residentId:resident.id,bedId:bed.id,moveInDate:date,monthlyPrice:'800000.50',paymentDay:12,depositAmount:'100000'});
  const active=await call('/occupancies/'+old.id+'/transfer',{bedId:target.id,transferDate:date});
  const detail=await call('/residents/'+resident.id);
  const audit=(await call('/audit')).filter(e=>e.entityId===resident.id);
  assert.equal(detail.occupancies.length,2);
  assert.equal(detail.occupancies.find(o=>o.id===old.id).status,'CLOSED');
  assert.equal(detail.occupancies.find(o=>o.id===active.id).status,'ACTIVE');
  assert.equal(active.roomId,targetRoom.id);assert.equal(active.bedId,target.id);
  assert.equal(active.monthlyPrice,old.monthlyPrice);assert.equal(active.depositAmount,old.depositAmount);
  assert.deepEqual(audit.map(e=>e.action).sort(),['OCCUPANCY_CHECKED_IN','OCCUPANCY_TRANSFERRED','RESIDENT_CREATED']);
  fs.mkdirSync('.local',{recursive:true});
  fs.writeFileSync(state,JSON.stringify({recordedAt:new Date().toISOString(),cookie,residents:await call('/residents'),rooms:await call('/rooms'),dashboard:await call('/dashboard'),activeId:active.id,closedId:old.id,residentId:resident.id,detail,audit,roomId:targetRoom.id,roomNumber:targetRoom.number,bedNumber:target.number}),{mode:0o600});
  console.log('Recorded resident, transfer, ACTIVE/CLOSED history, audit, rooms, counters and session.');
 }else if(process.argv[2]==='after'){
  const saved=JSON.parse(fs.readFileSync(state));cookie=saved.cookie;
  assert.deepEqual(await call('/residents'),saved.residents);assert.deepEqual(await call('/rooms'),saved.rooms);assert.deepEqual(await call('/dashboard'),saved.dashboard);
  assert.deepEqual(await call('/residents/'+saved.residentId),saved.detail);
  assert.deepEqual((await call('/audit')).filter(e=>e.entityId===saved.residentId),saved.audit);
  const browser=await chromium.launch();
  try {
   const context=await browser.newContext({viewport:{width:390,height:844}});
   const split=cookie.indexOf('=');
   await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();
   await page.goto(origin+'/residents/'+saved.residentId);
   await page.getByRole('heading',{name:saved.detail.fullName,exact:true}).waitFor();
   assert.equal(await page.locator('.stay-row').count(),2);
   assert.ok((await page.locator('.resident-location').innerText()).includes(`Комната ${saved.roomNumber} / Место ${saved.bedNumber}`));
   await page.goto(origin+'/rooms/'+saved.roomId);
   const card=page.locator('.bed-card').filter({hasText:saved.detail.fullName});await card.waitFor();
   assert.match(await card.innerText(),/Занято/);
   await page.screenshot({path:'.local/screenshots/m2-persistence-after.png',fullPage:true});
  } finally {await browser.close();}
  console.log('M2 PERSISTENCE: PASS — ACTIVE/CLOSED history, audit, room/bed, counters, session and rendered occupancy unchanged.');
 } else {throw Error('Use before or after');}
})().catch(e=>{console.error(e.message);process.exit(1);});
