'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Status = { status: 'NONE' | 'INVITED' | 'ACTIVE' | 'DISABLED'; telegramLinked: boolean; activatedAt?: string | null; lastSeenAt?: string | null; activeSessions?: number; pendingInviteExpiresAt?: string | null };
type Sent = { channel: 'TELEGRAM' | 'LINK'; delivered: boolean; link?: string; expiresAt: string };
const labels: Record<Status['status'], string> = { NONE: 'Не приглашён', INVITED: 'Приглашён, пароль ещё не задан', ACTIVE: 'Пользуется приложением', DISABLED: 'Доступ закрыт' };
const when = (iso?: string | null) => iso ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

export function AppAccountPanel({ residentId, living }: { residentId: string; living: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const load = () => api<Status>(`/residents/${residentId}/app-account`).then(setStatus).catch(e => setError((e as Error).message));
  useEffect(() => { setSent(null); setConfirmClose(false); void load(); }, [residentId]);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const invite = (channel: 'AUTO' | 'LINK') => run(async () => { setSent(await api<Sent>(`/residents/${residentId}/app-invite`, { method: 'POST', body: JSON.stringify({ channel }) })); });
  async function copy(link: string) { try { await navigator.clipboard.writeText(link); setError(''); } catch { setError('Не удалось скопировать. Выделите ссылку вручную.'); } }
  return <section className="panel app-account"><h2>Приложение жильца</h2>
    {error && <p className="error" role="alert">{error}</p>}
    {!status ? <p role="status">Загружаем…</p> : <>
      <p><strong>{labels[status.status]}</strong></p>
      <dl className="detail-grid">
        <dt>Telegram</dt><dd>{status.telegramLinked ? 'Подключён' : 'Не подключён'}</dd>
        {status.status === 'ACTIVE' && <><dt>Последний вход</dt><dd>{when(status.lastSeenAt)}</dd><dt>Устройств</dt><dd>{status.activeSessions ?? 0}</dd></>}
        {status.pendingInviteExpiresAt && <><dt>Приглашение действует до</dt><dd>{when(status.pendingInviteExpiresAt)}</dd></>}
      </dl>
      {sent && (sent.link
        ? <div className="invite-link"><p>Передайте жильцу эту ссылку лично. Она одноразовая и действует 48 часов.</p><code>{sent.link}</code><button className="button secondary" type="button" onClick={() => void copy(sent.link!)}>Скопировать ссылку</button></div>
        : <p role="status">{sent.delivered ? 'Приглашение отправлено в Telegram.' : 'Telegram сейчас недоступен. Повторите позже или получите ссылку.'}</p>)}
      {living ? <div className="resident-actions">
        {status.telegramLinked && <button className="button primary" disabled={busy} onClick={() => void invite('AUTO')}>{status.status === 'NONE' ? 'Пригласить через Telegram' : 'Отправить новое приглашение'}</button>}
        <button className="button secondary" disabled={busy} onClick={() => void invite('LINK')}>{status.telegramLinked ? 'Получить ссылку' : status.status === 'NONE' ? 'Пригласить по ссылке' : 'Новая ссылка'}</button>
        {['ACTIVE', 'INVITED'].includes(status.status) && (confirmClose
          ? <><button className="button secondary" disabled={busy} onClick={() => void run(async () => { await api(`/residents/${residentId}/app-account`, { method: 'PATCH', body: JSON.stringify({ active: false }) }); setConfirmClose(false); setSent(null); })}>Да, закрыть доступ</button><button className="button secondary" onClick={() => setConfirmClose(false)}>Отмена</button></>
          : <button className="button secondary" disabled={busy} onClick={() => setConfirmClose(true)}>Закрыть доступ</button>)}
      </div> : <p className="form-hint">Пригласить можно только жильца, который сейчас проживает. При выселении доступ закрывается автоматически.</p>}
      <p className="form-hint">Новое приглашение отменяет предыдущее. Задав новый пароль, жилец выходит со всех устройств.</p>
    </>}
  </section>;
}
