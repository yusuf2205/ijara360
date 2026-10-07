'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Session = { id: string; deviceName: string | null; platform: string; remembered: boolean; createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean; user?: { id: string; fullName: string; role: string } };
const platformLabel: Record<string, string> = { WEB: 'Браузер', ANDROID: 'Android', IOS: 'iPhone', WINDOWS: 'Windows' };
const when = (iso: string | null) => iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

export function SessionsPanel({ owner }: { owner: boolean }) {
  const [mine, setMine] = useState<Session[] | null>(null);
  const [staff, setStaff] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    try {
      setMine(await api<Session[]>('/auth/sessions'));
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
  return <section className="panel"><div className="panel-heading"><h2>Мои устройства</h2></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!mine ? <p role="status">Загружаем устройства…</p> : <div className="session-list">{mine.map(s => row(s))}</div>}
    {owner && <><h3 style={{ marginTop: 20 }}>Устройства сотрудников</h3>
      {staff && staff.filter(s => s.user && !mine?.some(m => m.id === s.id)).length ? <div className="session-list">{staff.filter(s => !mine?.some(m => m.id === s.id)).map(s => row(s, true))}</div> : <p className="form-hint">Других активных сессий нет.</p>}
      <p className="form-hint">Завершённое устройство сразу выходит из системы. Действие записывается в журнал.</p></>}
  </section>;
}
