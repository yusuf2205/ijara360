'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Session = { id: string; deviceName: string | null; platform: string; remembered: boolean; createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean; user?: { id: string; fullName: string; role: string } };
const platformLabel: Record<string, string> = { WEB: 'Браузер', ANDROID: 'Android', IOS: 'iPhone', WINDOWS: 'Windows' };
const when = (iso: string | null) => iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

type Trusted = { id: string; label: string; platform: string; createdAt: string; lastUsedAt: string };

/** Telegram for confirmations and notifications: linked by sharing the own contact with the bot. */
export function TelegramPanel() {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<{ linked: boolean }>('/auth/telegram').then(r => { setLinked(r.linked); if (r.linked) setUrl(''); }).catch(e => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  // After the link is opened, watch for the bot to finish (up to ten minutes).
  useEffect(() => { if (!url) return; const t = setInterval(() => void load(), 3000); const stop = setTimeout(() => clearInterval(t), 600000); return () => { clearInterval(t); clearTimeout(stop); }; }, [url]);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="panel telegram-panel"><div className="panel-heading"><h2>Telegram</h2></div>
    {error && <p className="error" role="alert">{error}</p>}
    {linked === null ? <p role="status">Загружаем…</p> : linked ? <>
      <p><span className="status-pill"><span className="dot"/>Привязан</span></p>
      <p className="form-hint">Сюда приходят уведомления и подтверждения входа с новых устройств через интернет.</p>
      <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await api('/auth/telegram', { method: 'DELETE' }); await load(); })}>Отвязать Telegram</button>
    </> : <>
      <p className="form-hint">Привяжите Telegram, чтобы входить в кабинет из интернета и получать уведомления. Бот попросит поделиться вашим номером: он должен совпадать с номером учётной записи.</p>
      {url ? <><a className="button primary" href={url} target="_blank" rel="noreferrer">Открыть @ijara360bot</a><p className="form-hint">Нажмите «Старт» и «Подтвердить мой телефон». Эта страница обновится сама.</p></>
        : <button className="button primary" disabled={busy} onClick={() => void run(async () => { setUrl((await api<{ url: string }>('/auth/telegram/link', { method: 'POST' })).url); })}>Привязать Telegram</button>}
    </>}
  </section>;
}

export function SessionsPanel({ owner }: { owner: boolean }) {
  const [mine, setMine] = useState<Session[] | null>(null);
  const [staff, setStaff] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [trusted, setTrusted] = useState<Trusted[]>([]);
  async function load() {
    try {
      setMine(await api<Session[]>('/auth/sessions'));
      setTrusted(await api<Trusted[]>('/auth/devices'));
      if (owner) setStaff((await api<Session[]>('/auth/staff-sessions')).filter(s => !s.current));
      setError('');
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [owner]);
  async function end(s: Session) {
    setBusy(s.id); setError('');
    try {
      if (s.current) { await api('/auth/logout', { method: 'POST' }); window.location.href = '/login'; return; }
      await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }
  const row = (s: Session, withUser = false) => <div className="session-row" key={s.id}>
    <div><strong>{withUser && s.user ? `${s.user.fullName} · ` : ''}{s.deviceName || platformLabel[s.platform] || 'Устройство'}</strong>
      <small>{platformLabel[s.platform] || s.platform} · активность {when(s.lastSeenAt || s.createdAt)} · {s.remembered ? `запомнено до ${when(s.expiresAt)}` : `до ${when(s.expiresAt)}`}</small></div>
    {s.current ? <button className="button secondary" disabled={busy === s.id} onClick={() => void end(s)}>Выйти на этом устройстве</button>
      : <button className="button secondary" disabled={busy === s.id} onClick={() => void end(s)}>Завершить</button>}
  </div>;
  return <><section className="panel"><div className="panel-heading"><h2>Мои устройства</h2></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!mine ? <p role="status">Загружаем устройства…</p> : <div className="session-list">{mine.map(s => row(s))}</div>}
    {owner && <><h3 style={{ marginTop: 20 }}>Устройства сотрудников</h3>
      {staff && staff.filter(s => s.user && !mine?.some(m => m.id === s.id)).length ? <div className="session-list">{staff.filter(s => !mine?.some(m => m.id === s.id)).map(s => row(s, true))}</div> : <p className="form-hint">Других активных сессий нет.</p>}
      <p className="form-hint">Завершённое устройство сразу выходит из системы. Действие записывается в журнал.</p></>}
  </section>
  <section className="panel"><div className="panel-heading"><h2>Доверенные устройства</h2></div>
    <p className="form-hint">С них можно входить через интернет без подтверждения в Telegram. Удалите устройство, если потеряли его.</p>
    {trusted.length ? <div className="session-list">{trusted.map(d => <div className="session-row" key={d.id}><div><strong>{d.label}</strong><small>{platformLabel[d.platform] || d.platform} · последний вход {when(d.lastUsedAt)}</small></div>
      <button className="button secondary" disabled={busy === d.id} onClick={() => { setBusy(d.id); setError(''); api(`/auth/devices/${d.id}`, { method: 'DELETE' }).then(load).catch(e => setError((e as Error).message)).finally(() => setBusy('')); }}>Удалить</button></div>)}</div> : <p className="form-hint">Пока нет.</p>}
  </section></>;
}
