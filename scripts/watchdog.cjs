// Server watchdog (compose service "watchdog"), see docs/M6-RELIABILITY.md.
// Every minute: every entrance, the database, the nightly backup and free space. A problem confirmed by
// two checks in a row goes to every owner with a linked Telegram, is repeated every 6 hours while it
// lasts, and its end is announced. A short summary every morning at 09:00 proves the watchdog is alive.
// The status file feeds the owner's "Сервер" panel. Messages, logs and files carry no personal data.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REPEAT_AFTER = 6 * HOUR;
const BACKUP_MAX_AGE = 26 * HOUR;
const BACKUP_GRACE = 2 * HOUR;
const OFFSITE_MAX_AGE = 30 * HOUR;
const SUMMARY_HOUR = 9;
const DISK_MIN_FREE = 20 * 1024 ** 3;
const DISK_MIN_SHARE = 0.05;
const TZ = 'Asia/Tashkent';

const LABELS = {
  api: 'Сервер приложения',
  database: 'База данных',
  tailnet: 'Вход через Tailscale',
  internet: 'Вход из интернета',
  lan: 'Вход из домашней сети',
  domain: 'Вход через домен',
  backup: 'Ночная резервная копия',
  cloud: 'Копия в облаке',
  usb: 'Копия на USB-диске',
  disk: 'Место на диске',
  realtime: 'Обновления в реальном времени',
  locationApi: 'Геолокация: приём',
  locationWorker: 'Геолокация: статусы',
  retention: 'Геолокация: очистка истории',
  map: 'Карта (Яндекс)',
};

function formatBytes(n) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

function local(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), text: `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}` };
}

function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
}

/** Backup status file -> check result. `startedAt` gives the service time for its first run. */
function backupResult(record, now, startedAt) {
  if (!record) return now - startedAt < BACKUP_GRACE ? { ok: null, detail: 'ждём первую копию' } : { ok: false, detail: 'нет данных о копии' };
  const at = Date.parse(record.at);
  if (!record.ok) return { ok: false, detail: `не удалась (${local(at).text})` };
  if (!(now - at < BACKUP_MAX_AGE)) return { ok: false, detail: `последняя копия ${duration(now - at)} назад` };
  return { ok: true, detail: `${local(at).text}, ${formatBytes(record.bytes || 0)}`, at: record.at, bytes: record.bytes, documents: record.documents };
}

/** Offsite target status (offsite-cloud.json / offsite-usb.json written by scripts/offsite-service.sh). */
function offsiteResult(record, now, startedAt) {
  if (!record) return now - startedAt < BACKUP_GRACE ? { ok: null, detail: 'ждём первую отправку' } : { ok: false, detail: 'нет данных об отправке' };
  const at = Date.parse(record.at);
  if (record.ok === null) return { ok: null, detail: String(record.detail || 'не настроено') };
  if (!record.ok) return { ok: false, detail: `${record.detail || 'не удалась'} (${local(at).text})` };
  if (!(now - at < OFFSITE_MAX_AGE)) return { ok: false, detail: `последняя отправка ${duration(now - at)} назад` };
  return { ok: true, detail: `${local(at).text}, ${record.detail || ''}`.replace(/, $/, '') };
}

/**
 * M7 parts reported by /api/health (private listener): the realtime LISTEN connection, the status worker
 * (every 30 s), the retention worker (hourly) and whether a map key is configured. Null = not known yet.
 */
function apiParts(health, now, startedAt) {
  const loc = health && health.location;
  if (!health) return { realtime: { ok: null, detail: 'нет ответа API' }, locationApi: { ok: null, detail: 'нет ответа API' }, locationWorker: { ok: null, detail: 'нет ответа API' }, retention: { ok: null, detail: 'нет ответа API' }, map: { ok: null, detail: 'нет ответа API' } };
  const early = now - startedAt < 10 * MINUTE;
  const age = (s, max, label) => s == null ? (early ? { ok: null, detail: 'ещё не запускался' } : { ok: false, detail: `${label} не запускается` })
    : s <= max ? { ok: true, detail: `работает (${duration(s * 1000)} назад)` } : { ok: false, detail: `не работал ${duration(s * 1000)}` };
  return {
    realtime: health.realtime === true ? { ok: true, detail: 'работает' } : { ok: false, detail: 'нет связи с базой' },
    locationApi: loc ? { ok: true, detail: loc.lastUpload == null ? 'работает, точек пока не было' : `работает, последняя точка ${duration(loc.lastUpload * 1000)} назад` } : { ok: false, detail: 'модуль не отвечает' },
    locationWorker: loc ? age(loc.statusWorker, 120, 'процесс') : { ok: false, detail: 'модуль не отвечает' },
    retention: loc ? age(loc.retentionWorker, 3 * 3600, 'очистка') : { ok: false, detail: 'модуль не отвечает' },
    // Without a commercial key the map is "not connected": grey, not an alarm (docs/M7-LOCATION.md).
    // With a key, Yandex itself must accept it (the API checks hourly with each staff origin as Referer).
    map: !loc || !loc.mapConfigured ? { ok: null, detail: 'не подключена' }
      : loc.mapKey === 'ok' ? { ok: true, detail: 'ключ принят Яндексом' }
      : loc.mapKey === 'rejected' ? { ok: false, detail: 'Яндекс не принимает ключ (проверьте ключ JavaScript API и HTTP Referer)' }
      : { ok: null, detail: 'ключ ещё не проверен' },
  };
}

function diskResult(free, total) {
  const ok = free >= DISK_MIN_FREE && free / total >= DISK_MIN_SHARE;
  return { ok, detail: `свободно ${formatBytes(free)} из ${formatBytes(total)}`, free, total };
}

/**
 * Pure decision step. `state.checks[key]` = {ok, since, fails, alertedAt}; results[key] = {ok: true|false|null, detail}.
 * Returns the next state and the Telegram messages to send (no personal data).
 */
function evaluate(state, results, now) {
  const checks = { ...(state.checks || {}) };
  const raised = [], repeated = [], recovered = [];
  for (const [key, result] of Object.entries(results)) {
    const prev = checks[key] || { ok: null, since: now, fails: 0, alertedAt: null };
    const next = { ...prev, detail: result.detail };
    if (result.ok === null) {
      next.ok = null;
    } else if (result.ok) {
      if (prev.alertedAt) recovered.push(`${LABELS[key]}: снова работает, сбой длился ${duration(now - prev.since)}`);
      if (prev.ok !== true) next.since = now;
      Object.assign(next, { ok: true, fails: 0, alertedAt: null });
    } else {
      if (prev.ok !== false) next.since = now;
      next.ok = false;
      next.fails = (prev.fails || 0) + 1;
      if (next.fails >= 2 && !prev.alertedAt) { raised.push(`${LABELS[key]}: ${result.detail}`); next.alertedAt = now; }
      else if (prev.alertedAt && now - prev.alertedAt >= REPEAT_AFTER) { repeated.push(`${LABELS[key]}: ${result.detail} (с ${local(next.since).text})`); next.alertedAt = now; }
    }
    checks[key] = next;
  }
  const messages = [];
  if (raised.length) messages.push(`⚠️ Ijara360: сбой\n${raised.map(s => `• ${s}`).join('\n')}`);
  if (repeated.length) messages.push(`⚠️ Ijara360: сбой продолжается\n${repeated.map(s => `• ${s}`).join('\n')}`);
  if (recovered.length) messages.push(`✅ Ijara360\n${recovered.map(s => `• ${s}`).join('\n')}`);
  let summaryDay = state.summaryDay || null;
  const today = local(now);
  if (today.hour >= SUMMARY_HOUR && summaryDay !== today.day) {
    summaryDay = today.day;
    const failing = Object.entries(checks).filter(([, c]) => c.ok === false);
    const lines = [failing.length ? `Утренняя сводка: есть проблемы (${failing.length})` : 'Утренняя сводка: всё работает'];
    for (const [key, c] of failing) lines.push(`• ${LABELS[key]}: ${c.detail}`);
    if (results.backup && results.backup.ok) lines.push(`Копия: ${results.backup.detail}`);
    if (results.disk) lines.push(`Диск: ${results.disk.detail}`);
    messages.push(`Ijara360. ${lines.join('\n')}`);
  }
  return { state: { checks, summaryDay }, messages };
}

// --- I/O -----------------------------------------------------------------------------------

function httpStatus(url, { host, timeout = 10_000 } = {}) {
  if (url.startsWith('https:')) {
    // Home entrance: local certificate authority, so only reachability is checked here. No SNI, as a
    // browser sends none to an IP address: Caddy answers with the 192.168.1.105 certificate (default_sni).
    return new Promise(resolve => {
      const req = https.get(url, { rejectUnauthorized: false, servername: '', headers: host ? { Host: host } : {}, timeout }, res => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(0));
    });
  }
  return fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' }).then(r => r.status, () => 0);
}

async function httpCheck(url, expected, options) {
  const status = await httpStatus(url, options);
  return status === expected ? { ok: true, detail: 'работает' } : { ok: false, detail: status ? `отвечает с ошибкой ${status}` : 'нет ответа' };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

async function withDb(fn) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
  try { await client.connect(); return await fn(client); } finally { client.end().catch(() => {}); }
}

async function main() {
  const dir = process.env.SERVER_STATUS_PATH || '/var/lib/ijara360/status';
  const urls = {
    api: process.env.WATCH_API || 'http://api:4000/api/health',
    tailnet: process.env.WATCH_TAILNET || 'http://gateway:8080/api/health',
    internet: process.env.WATCH_INTERNET || 'http://gateway:8081/login',
    lan: process.env.WATCH_LAN || 'https://gateway-lan/api/health',
    // Own domain through Cloudflare: the real path from the internet, set once the tunnel exists.
    domain: process.env.WATCH_DOMAIN ? `https://${process.env.WATCH_DOMAIN}/apply` : null,
  };
  const lanHost = process.env.LAN_HOST || '192.168.1.105';
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const startedAt = Date.now();
  const stateFile = path.join(dir, 'watchdog-state.json');
  let state = readJson(stateFile) || {};
  let recipients = [];
  let recipientsAt = 0;
  let outbox = [];

  async function send(text) {
    let delivered = 0;
    for (const chat of recipients) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(20_000) });
        if (r.ok) delivered++; else console.log(`telegram send failed status=${r.status}`);
      } catch { console.log('telegram send failed: no connection'); }
    }
    return delivered > 0;
  }

  async function tick() {
    const now = Date.now();
    const results = {};
    const health = await fetch(urls.api, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null, () => null).catch(() => null);
    const [api, tailnet, internet, lan, domain] = await Promise.all([
      httpCheck(urls.api, 200), httpCheck(urls.tailnet, 200), httpCheck(urls.internet, 200), httpCheck(urls.lan, 200, { host: lanHost }),
      urls.domain ? httpCheck(urls.domain, 200) : { ok: null, detail: 'не подключён' },
    ]);
    Object.assign(results, { api, tailnet, internet, lan, domain }, apiParts(health, now, startedAt));
    try {
      await withDb(async db => {
        await db.query('SELECT 1');
        if (now - recipientsAt > 10 * MINUTE) {
          const rows = await db.query("SELECT telegram_user_id FROM users WHERE active AND role IN ('SUPER_ADMIN','OWNER') AND telegram_user_id IS NOT NULL");
          recipients = rows.rows.map(r => r.telegram_user_id);
          recipientsAt = now;
        }
      });
      results.database = { ok: true, detail: 'работает' };
    } catch {
      results.database = { ok: false, detail: 'нет подключения' };
    }
    results.backup = backupResult(readJson(path.join(dir, 'backup.json')), now, startedAt);
    results.cloud = offsiteResult(readJson(path.join(dir, 'offsite-cloud.json')), now, startedAt);
    results.usb = offsiteResult(readJson(path.join(dir, 'offsite-usb.json')), now, startedAt);
    try {
      const s = fs.statfsSync(dir);
      results.disk = diskResult(s.bavail * s.bsize, s.blocks * s.bsize);
    } catch {
      results.disk = { ok: false, detail: 'не удалось проверить' };
    }

    const step = evaluate(state, results, now);
    state = step.state;
    writeJson(stateFile, state);
    writeJson(path.join(dir, 'watchdog.json'), {
      checkedAt: new Date(now).toISOString(),
      checks: Object.keys(LABELS).map(key => ({ key, label: LABELS[key], ok: state.checks[key]?.ok ?? null, detail: state.checks[key]?.detail || '', since: state.checks[key]?.since ? new Date(state.checks[key].since).toISOString() : null })),
      backup: results.backup.ok ? { at: results.backup.at, bytes: results.backup.bytes, documents: results.backup.documents } : null,
      disk: results.disk.total ? { free: results.disk.free, total: results.disk.total } : null,
      telegram: Boolean(token) && recipients.length > 0,
    });
    for (const [key, c] of Object.entries(state.checks)) if (c.ok === false && c.fails === 2) console.log(`problem: ${key}`);
    outbox.push(...step.messages);
    outbox = outbox.slice(-20);
    if (token && recipients.length) {
      while (outbox.length && await send(outbox[0])) outbox.shift();
    }
  }

  console.log(`watchdog started; telegram ${token ? 'configured' : 'not configured'}`);
  for (;;) {
    try { await tick(); } catch (e) { console.log(`watchdog tick failed: ${e && e.code || 'error'}`); }
    await new Promise(r => setTimeout(r, MINUTE));
  }
}

module.exports = { evaluate, apiParts, backupResult, offsiteResult, diskResult, formatBytes, local, LABELS };
if (require.main === module) main();
