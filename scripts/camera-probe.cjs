// Cameras: what the home's Hikvision cameras can do, before they are connected to Ijara360.
// Run on a computer in the home network:   node scripts/camera-probe.cjs 192.168.1.242 192.168.1.243
// Asks for the camera login and password with hidden input, keeps them only in memory, prints no secrets.
// One request per question and it stops at the first refused login: Hikvision locks the account after a few
// wrong passwords.
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');

const hosts = process.argv.slice(2);
if (!hosts.length) { console.error('Укажите адреса камер, например: node scripts/camera-probe.cjs 192.168.1.242 192.168.1.243'); process.exit(1); }

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(question); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

function request(host, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: 80, method, path, timeout: 8000, headers: { ...(body ? { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('нет ответа')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
/** HTTP Digest (RFC 7616, MD5, qop=auth) as the cameras ask for it. */
async function isapi(cam, method, path, body) {
  if (cam.challenge) {
    const r = await request(cam.host, method, path, body, { Authorization: digest(cam, method, path) });
    if (r.status !== 401) return r;
  }
  const first = await request(cam.host, method, path, body);
  if (first.status !== 401) return first;
  const h = String(first.headers['www-authenticate'] || '');
  cam.challenge = Object.fromEntries([...h.matchAll(/(\w+)="?([^",]+)"?/g)].map(m => [m[1], m[2]]));
  cam.nc = 0;
  return request(cam.host, method, path, body, { Authorization: digest(cam, method, path) });
}
function digest(cam, method, uri) {
  const c = cam.challenge, nc = String(++cam.nc).padStart(8, '0'), cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${cam.user}:${c.realm}:${cam.password}`), ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${cam.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}
const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1];
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map(m => m[1]);
const gb = mb => mb ? `${(Number(mb) / 1024).toFixed(0)} ГБ` : '?';

async function probe(cam) {
  console.log(`\n=== Камера ${cam.host}`);
  const info = await isapi(cam, 'GET', '/ISAPI/System/deviceInfo');
  if (info.status === 401) { console.log('Логин или пароль не подошёл. Остановлено, чтобы камера не заблокировала вход.'); return false; }
  if (info.status !== 200) { console.log(`Камера ответила ${info.status}.`); return true; }
  console.log(`Модель: ${tag(info.body, 'model')} · прошивка ${tag(info.body, 'firmwareVersion')} ${tag(info.body, 'firmwareReleasedDate') || ''}`);
  for (const [id, label] of [['101', 'Основной поток'], ['102', 'Облегчённый поток']]) {
    const s = await isapi(cam, 'GET', `/ISAPI/Streaming/channels/${id}`);
    if (s.status !== 200) { console.log(`${label}: нет (${s.status})`); continue; }
    console.log(`${label}: ${tag(s.body, 'videoCodecType')} ${tag(s.body, 'videoResolutionWidth')}×${tag(s.body, 'videoResolutionHeight')}, ${Number(tag(s.body, 'maxFrameRate') || 0) / 100} кадр/с, ${tag(s.body, 'constantBitRate') || tag(s.body, 'vbrUpperCap') || '?'} кбит/с, звук: ${tag(s.body, 'enabled') === 'true' ? 'есть' : 'нет'}`);
  }
  const st = await isapi(cam, 'GET', '/ISAPI/ContentMgmt/Storage');
  if (st.status === 200) {
    const names = tags(st.body, 'hddName'), status = tags(st.body, 'status'), cap = tags(st.body, 'capacity'), free = tags(st.body, 'freeSpace');
    if (!names.length) console.log('Хранилище: карты памяти нет');
    names.forEach((n, i) => console.log(`Хранилище: ${n} · ${status[i]} · ${gb(cap[i])}, свободно ${gb(free[i])}`));
  } else console.log(`Хранилище: камера не сообщила (${st.status})`);
  const now = new Date(), from = new Date(now.getTime() - 30 * 86400000);
  const iso = d => d.toISOString().replace(/\.\d+Z$/, 'Z');
  const search = `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><trackList><trackID>101</trackID></trackList><timeSpanList><timeSpan><startTime>${iso(from)}</startTime><endTime>${iso(now)}</endTime></timeSpan></timeSpanList><maxResults>200</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
  const rec = await isapi(cam, 'POST', '/ISAPI/ContentMgmt/search', search);
  if (rec.status === 200) {
    const starts = tags(rec.body, 'startTime'), ends = tags(rec.body, 'endTime');
    console.log(starts.length ? `Записи за 30 дней: ${tag(rec.body, 'numOfMatches')} фрагментов${tag(rec.body, 'responseStatusStrg') === 'MORE' ? ' (и больше)' : ''}, самый ранний ${starts[0]}, последний до ${ends[ends.length - 1]}` : 'Записей за 30 дней нет');
  } else console.log(`Поиск записей: камера ответила ${rec.status}`);
  return true;
}

(async () => {
  const user = await ask('Логин камер (обычно admin): ', false) || 'admin';
  const same = (await ask('У всех камер один и тот же пароль? (да/нет): ', false)).toLowerCase().startsWith('д');
  let password = same ? await ask('Пароль камер (ввод скрыт): ', true) : '';
  for (const host of hosts) {
    const cam = { host, user, password: same ? password : await ask(`Пароль камеры ${host} (ввод скрыт): `, true) };
    try { if (!await probe(cam)) break; } catch (e) { console.log(`Камера ${host}: ${e.message}`); }
    cam.password = '';
  }
  password = '';
  console.log('\nГотово. Пароль нигде не сохранён. Скопируйте вывод (паролей в нём нет) и пришлите.');
})();
