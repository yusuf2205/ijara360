const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluate,backupResult,offsiteResult,diskResult,formatBytes,local}=require('../../../scripts/watchdog.cjs');

// 2026-10-14 05:00 UTC = 10:00 in Tashkent; 02:00 UTC = 07:00 (before the morning summary).
const morning=Date.parse('2026-10-14T02:00:00Z');
const MIN=60_000,HOUR=60*MIN;
const ok={ok:true,detail:'работает'};
const down={ok:false,detail:'нет ответа'};

test('one failed check is not an alarm; the second in a row is, once',()=>{
  let s={};
  let r=evaluate(s,{internet:down},morning);
  assert.deepEqual(r.messages,[]);
  r=evaluate(r.state,{internet:down},morning+MIN);
  assert.equal(r.messages.length,1);
  assert.match(r.messages[0],/^⚠️ Ijara360: сбой\n• Вход из интернета: нет ответа$/);
  r=evaluate(r.state,{internet:down},morning+2*MIN);
  assert.deepEqual(r.messages,[],'no repeat within 6 hours');
});

test('a single blip that recovers stays silent',()=>{
  let r=evaluate({},{lan:down},morning);
  r=evaluate(r.state,{lan:ok},morning+MIN);
  assert.deepEqual(r.messages,[]);
  assert.equal(r.state.checks.lan.fails,0);
});

test('a long outage is repeated every 6 hours and its end is announced with the duration',()=>{
  const quiet={summaryDay:'2026-10-14'};
  let r=evaluate(quiet,{database:down},morning);
  r=evaluate(r.state,{database:down},morning+MIN);
  r=evaluate(r.state,{database:down},morning+5*HOUR);
  assert.deepEqual(r.messages,[]);
  r=evaluate(r.state,{database:down},morning+MIN+6*HOUR);
  assert.equal(r.messages.length,1);
  assert.match(r.messages[0],/сбой продолжается\n• База данных: нет ответа \(с 14\.10 07:00\)/);
  r=evaluate(r.state,{database:ok},morning+7*HOUR);
  assert.equal(r.messages.length,1);
  assert.match(r.messages[0],/^✅ Ijara360\n• База данных: снова работает, сбой длился 7 ч$/);
  assert.equal(r.state.checks.database.alertedAt,null);
});

test('unknown results never alarm and do not count as failures',()=>{
  let r=evaluate({},{backup:{ok:null,detail:'ждём первую копию'}},morning);
  r=evaluate(r.state,{backup:{ok:null,detail:'ждём первую копию'}},morning+MIN);
  assert.deepEqual(r.messages,[]);
  assert.equal(r.state.checks.backup.ok,null);
});

test('the morning summary is sent once a day after 09:00 Tashkent time and lists problems',()=>{
  const ten=Date.parse('2026-10-14T05:00:00Z');
  let r=evaluate({},{api:ok,backup:{ok:true,detail:'14.10 03:30, 1,2 МБ'},disk:{ok:true,detail:'свободно 8 ТБ из 9 ТБ'}},ten);
  assert.equal(r.messages.length,1);
  assert.match(r.messages[0],/^Ijara360\. Утренняя сводка: всё работает\nКопия: 14\.10 03:30, 1,2 МБ\nДиск: свободно 8 ТБ из 9 ТБ$/);
  r=evaluate(r.state,{api:ok},ten+HOUR);
  assert.deepEqual(r.messages,[]);
  r=evaluate(r.state,{api:down},Date.parse('2026-10-15T03:00:00Z'));
  r=evaluate(r.state,{api:down},Date.parse('2026-10-15T04:00:00Z'));
  const summary=r.messages.find(m=>m.includes('Утренняя сводка'));
  assert.match(summary,/есть проблемы \(1\)\n• Сервер приложения: нет ответа/);
});

test('before 09:00 there is no summary',()=>{
  assert.deepEqual(evaluate({},{api:ok},morning).messages,[]);
  assert.equal(local(morning).hour,7);
});

test('backup: grace period at start, failure, staleness after 26 hours, success',()=>{
  const now=Date.parse('2026-10-14T05:00:00Z');
  assert.equal(backupResult(null,now,now-HOUR).ok,null);
  assert.equal(backupResult(null,now,now-3*HOUR).ok,false);
  assert.deepEqual(backupResult({ok:false,at:'2026-10-13T22:30:00Z',step:'dump'},now,0),{ok:false,detail:'не удалась (14.10 03:30)'});
  assert.equal(backupResult({ok:true,at:'2026-10-13T02:00:00Z',bytes:10},now,0).ok,false);
  assert.match(backupResult({ok:true,at:'2026-10-13T02:00:00Z',bytes:10},now,0).detail,/последняя копия 27 ч назад/);
  const good=backupResult({ok:true,at:'2026-10-13T22:30:00Z',bytes:1258291,documents:4},now,0);
  assert.equal(good.ok,true);
  assert.equal(good.detail,'14.10 03:30, 1,2 МБ');
  assert.equal(good.documents,4);
});

test('disk: alarm under 20 GB or under 5 % free',()=>{
  const G=1024**3;
  assert.equal(diskResult(8000*G,9000*G).ok,true);
  assert.equal(diskResult(19*G,9000*G).ok,false);
  assert.equal(diskResult(40*G,1000*G).ok,false);
  assert.equal(formatBytes(1258291),'1,2 МБ');
  assert.equal(formatBytes(512),'512 Б');
});

test('messages never carry phone numbers, names or ids',()=>{
  let r=evaluate({},{api:down,database:down,internet:down,lan:down,tailnet:down,backup:{ok:false,detail:'нет данных о копии'},disk:{ok:false,detail:'свободно 1 ГБ из 9 ТБ'}},morning);
  r=evaluate(r.state,{api:down,database:down,internet:down,lan:down,tailnet:down,backup:{ok:false,detail:'нет данных о копии'},disk:{ok:false,detail:'свободно 1 ГБ из 9 ТБ'}},morning+MIN);
  const text=r.messages.join('\n');
  assert.equal(r.messages.length,1);
  assert.doesNotMatch(text,/\+?\d{9,}|[0-9a-f]{8}-[0-9a-f]{4}/i);
  assert.equal(text.split('\n').length,8);
});

test('offsite copies: not configured is grey, a failure or 30 hours of silence is red, a recent copy is green',()=>{
  const now=Date.parse('2026-10-15T05:00:00Z');
  assert.equal(offsiteResult(null,now,now-HOUR).ok,null);
  assert.equal(offsiteResult(null,now,now-3*HOUR).ok,false);
  assert.deepEqual(offsiteResult({ok:null,at:'2026-10-15T04:00:00Z',detail:'Google Drive не подключён'},now,0),{ok:null,detail:'Google Drive не подключён'});
  assert.deepEqual(offsiteResult({ok:false,at:'2026-10-14T22:40:00Z',detail:'не удалось отправить'},now,0),{ok:false,detail:'не удалось отправить (15.10 03:40)'});
  assert.match(offsiteResult({ok:true,at:'2026-10-13T20:00:00Z',detail:'6,9 МБ'},now,0).detail,/последняя отправка 33 ч назад/);
  assert.deepEqual(offsiteResult({ok:true,at:'2026-10-14T22:40:00Z',detail:'6,9 МБ, дисков: 1'},now,0),{ok:true,detail:'15.10 03:40, 6,9 МБ, дисков: 1'});
  let r=evaluate({summaryDay:'2026-10-15'},{usb:{ok:false,detail:'нет USB-диска с папкой Ijara360-backup'}},now);
  r=evaluate(r.state,{usb:{ok:false,detail:'нет USB-диска с папкой Ijara360-backup'}},now+MIN);
  assert.match(r.messages[0],/Копия на USB-диске: нет USB-диска с папкой Ijara360-backup/);
});

test('M7 parts from /api/health: realtime, location intake, workers, map key', ()=>{
  const {apiParts}=require('../../../scripts/watchdog.cjs');
  const now=Date.parse('2026-10-15T05:00:00Z');
  const good=apiParts({realtime:true,location:{statusWorker:12,retentionWorker:1800,lastUpload:40,mapConfigured:true}},now,now-HOUR);
  for(const k of ['realtime','locationApi','locationWorker','retention','map'])assert.equal(good[k].ok,true,k);
  const bad=apiParts({realtime:false,location:{statusWorker:600,retentionWorker:null,lastUpload:null,mapConfigured:false}},now,now-HOUR);
  assert.equal(bad.realtime.ok,false);assert.equal(bad.locationWorker.ok,false);assert.equal(bad.retention.ok,false);
  assert.deepEqual(bad.map,{ok:null,detail:'не подключена'},'no key is grey, not an alarm');
  assert.equal(apiParts({realtime:true,location:{statusWorker:null,retentionWorker:null,mapConfigured:false}},now,now-MIN).locationWorker.ok,null,'just started');
  assert.equal(apiParts(null,now,now).realtime.ok,null,'API down is reported by its own check');
});
