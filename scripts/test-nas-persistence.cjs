// Run only against the isolated test services created for this project.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const base = 'http://192.168.1.105:4186/api';
(async () => {
  const login = await fetch(`${base}/auth/login`, {method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000','X-Ijara-Request':'1'},
    body:JSON.stringify({phone:'+998900000010',password:'UI test only strong password 2026'})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const before = await (await fetch(`${base}/rooms`,{headers:{Cookie:cookie}})).json();
  assert.equal(before.length,8);
  assert.equal(before.reduce((n,r)=>n+r.beds.length,0),59);
  execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','192.168.1.105','docker restart ijara360-test-postgres ijara360-test-api'],{stdio:'pipe'});
  let ready=false;
  for(let i=0;i<30;i++) {
    try { ready=(await fetch(`${base}/health`)).ok; } catch {}
    if(ready) break;
    await new Promise(r=>setTimeout(r,500));
  }
  assert.equal(ready,true);
  const response=await fetch(`${base}/rooms`,{headers:{Cookie:cookie}});
  assert.equal(response.status,200,'Session must survive API and database restart');
  assert.deepEqual(await response.json(),before);
  console.log('PASS: 8 rooms, 59 beds and the session survive PostgreSQL + API restart. Production was not modified.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
