// Dedicated test gateway only. Stores a test session locally, never a production credential.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const base='http://100.126.164.29:3187';
const stateFile='.local/m3-persistence.json';
async function read(cookie){
 const res=await fetch(base+'/api/finance',{headers:{Cookie:cookie}});assert.equal(res.status,200);
 const snapshot=await res.json();delete snapshot.asOf;
 for(const resident of snapshot.residents)delete resident.financeCheckedAt;
 return snapshot;
}
(async()=>{
 const mode=process.argv[2];
 if(mode==='before'){
  const res=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Ijara-Request':'1'},body:JSON.stringify({phone:'+998900000011',password:'UI test only strong password 2026'})});assert.equal(res.status,200);
  const cookie=res.headers.get('set-cookie').split(';')[0];const snapshot=await read(cookie);
  assert(snapshot.chargeCount>0&&snapshot.paymentCount>0,'Run M3 UI fixtures first');assert(snapshot.payments.some(p=>p.allocations.length>1),'Split allocation required');assert(Number(snapshot.summary.creditBalance)>0,'Remaining credit required');
  fs.writeFileSync(stateFile,JSON.stringify({cookie,snapshot}));console.log('M3 persistence baseline saved: charges, receipts, allocations, advance, access and summary.');
 }else if(mode==='after'){
  const {cookie,snapshot}=JSON.parse(fs.readFileSync(stateFile,'utf8'));assert.deepEqual(await read(cookie),snapshot);console.log('M3 PERSISTENCE: PASS');
 }else throw Error('before or after required');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
