'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Check = { key: string; label: string; ok: boolean | null; detail: string; since: string | null };
type Status = { available: false } | { available: true; checkedAt: string; stale: boolean; checks: Check[]; backup: { at: string; bytes: number | null; documents: number | null } | null; disk: { free: number | null; total: number | null } | null; telegram: boolean };

const when = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const size = (n: number | null) => { if (n == null) return '—'; const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toLocaleString('ru-RU', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${u[i]}`; };

/** Owner only: what the server watchdog saw a minute ago (entrances, database, nightly backup, disk). */
export function SystemPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api<Status>('/system/status').then(s => { setStatus(s); setError(''); }).catch(e => setError((e as Error).message));
    void load();
    const t = setInterval(() => void load(), 60000);
    return () => clearInterval(t);
  }, []);
  const failing = status?.available ? status.checks.filter(c => c.ok === false) : [];
  return <section className="panel server-panel" aria-labelledby="server-heading"><div className="panel-heading"><h2 id="server-heading">Сервер</h2></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!status ? <p role="status">Загружаем…</p> : !status.available ? <p className="form-hint">Сторож сервера ещё не запускался. Состояние появится через минуту после выпуска.</p> : <>
      <p className={`server-summary ${status.stale || failing.length ? 'bad' : 'good'}`} role="status">
        {status.stale ? `Сторож не отвечает с ${when(status.checkedAt)}` : failing.length ? `Есть проблемы: ${failing.length}` : 'Всё работает'}
      </p>
      <ul className="server-checks">{status.checks.map(c => <li key={c.key}>
        <span className={`dot ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'wait'}`} aria-hidden="true" />
        <span><strong>{c.label}</strong><small>{c.ok === false && c.since ? `${c.detail} · с ${when(c.since)}` : c.detail}</small></span>
      </li>)}</ul>
      <dl className="server-facts">
        <div><dt>Последняя копия</dt><dd>{status.backup ? `${when(status.backup.at)} · ${size(status.backup.bytes)}` : '—'}</dd></div>
        <div><dt>Свободно на диске</dt><dd>{status.disk ? `${size(status.disk.free)} из ${size(status.disk.total)}` : '—'}</dd></div>
        <div><dt>Проверено</dt><dd>{when(status.checkedAt)}</dd></div>
      </dl>
      <p className="form-hint">{status.telegram ? 'О сбоях и каждое утро в 09:00 сторож пишет вам в Telegram.' : 'Привяжите Telegram выше, чтобы сторож сообщал о сбоях и присылал утреннюю сводку.'}</p>
    </>}
  </section>;
}
