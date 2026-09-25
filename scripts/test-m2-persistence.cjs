const fs=require('node:fs');
const assert=require('node:assert/strict');
const base='http://100.126.164.29:4187/api'; // dedicated M2 test container only
const state='.local/m2-persistence.json';
let cookie;
async function call(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:'http://localhost:3000','X-Ijara-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(path+': '+r.status);if(path==='/auth/login')cookie=r.headers.get('set-cookie').split(';')[0];return r.json();}
(async()=>{
 if(process.argv[2]==='before'){
  await call('/auth/login',{phone:'+998900000010',password:'UI test only strong password 2026'});
  const rooms=await call('/rooms');const bed=rooms.flatMap(r=>r.beds).find(b=>b.status==='AVAILABLE');
  const active=await call('/occupancies/check-in',{resident:{fullName:'Restart verification test',phone:'+998901234590'},bedId:bed.id,moveInDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),monthlyPrice:'800000',paymentDay:12,depositAmount:'100000'});
  fs.writeFileSync(state,JSON.stringify({cookie,residents:await call('/residents'),rooms:await call('/rooms'),dashboard:await call('/dashboard'),activeId:active.id}));
  console.log('Recorded residents, all occupancy history, rooms, counters and session.');
 }else{
  const saved=JSON.parse(fs.readFileSync(state));cookie=saved.cookie;
  assert.deepEqual(await call('/residents'),saved.residents);assert.deepEqual(await call('/rooms'),saved.rooms);assert.deepEqual(await call('/dashboard'),saved.dashboard);
  console.log('Restart PASS: active occupancy, closed history, room status, counters and session unchanged.');
 }
})().catch(e=>{console.error(e.message);process.exit(1);});
