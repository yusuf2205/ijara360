'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';

type Item = { id: string; category: string; status: string; title: string; version: number; createdAt: string; updatedAt: string; closedAt: string | null; messages: number; room: string | null; author: { residentId: string; fullName: string } | null };
type Detail = Item & { thread: { id: string; author: 'TENANT' | 'STAFF'; name: string; body: string; createdAt: string }[] };
type List = { items: Item[]; total: number; page: number; pageSize: number; counts: Record<string, number> };

export const ticketCategory: Record<string, string> = { COMPLAINT: 'Жалоба', SUGGESTION: 'Предложение', REPAIR: 'Поломка' };
export const ticketStatus: Record<string, string> = { OPEN: 'Новое', IN_PROGRESS: 'В работе', RESOLVED: 'Решено', REJECTED: 'Отклонено' };
const filters: [string, string][] = [['ACTIVE', 'Активные'], ['OPEN', 'Новые'], ['IN_PROGRESS', 'В работе'], ['CLOSED', 'Закрытые'], ['', 'Все']];
const when = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function TicketsPanel({ id, permissions }: { id?: string; permissions: string[] }) {
  const [status, setStatus] = useState('ACTIVE');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = permissions.includes('TICKETS_MANAGE');
  async function refresh() {
    try {
      if (id) setDetail(await api<Detail>(`/tickets/${id}`));
      else setList(await api<List>(`/tickets?${new URLSearchParams({ ...(status ? { status } : {}), ...(category ? { category } : {}), page: String(page) })}`));
      setError('');
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, [id, status, category, page]);
  async function run(fn: () => Promise<Detail>) { setBusy(true); setError(''); try { setDetail(await fn()); } catch (e) { setError((e as Error).message); await refresh(); } finally { setBusy(false); } }
  function send(e: FormEvent) { e.preventDefault(); if (!detail || !reply.trim()) return; void run(async () => { const d = await api<Detail>(`/tickets/${detail.id}/messages`, { method: 'POST', body: JSON.stringify({ body: reply }) }); setReply(''); return d; }); }
  const setTo = (next: string) => detail && run(() => api<Detail>(`/tickets/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ status: next, version: detail.version }) }));
  if (!permissions.includes('TICKETS_VIEW') && !canManage) return <p>У вас нет доступа к обращениям.</p>;
  const open = detail && ['OPEN', 'IN_PROGRESS'].includes(detail.status);
  return <div className="tickets">
    <div className="page-heading"><div><div className="heading-kicker">ОБРАЩЕНИЯ ЖИЛЬЦОВ</div><h1>{id ? 'Обращение' : 'Обращения'}</h1><p>Жалобы, предложения и поломки из приложения жильца.</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!id ? <>
      <div className="applications-toolbar" aria-label="Статус">{filters.map(([value, label]) => <button key={value || 'all'} className={`button ${status === value ? 'primary' : 'secondary'}`} onClick={() => { setStatus(value); setPage(1); }}>{label}{value === 'OPEN' && list?.counts.OPEN ? ` (${list.counts.OPEN})` : ''}</button>)}</div>
      <label className="ticket-category">Тип<select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="">Все типы</option>{Object.entries(ticketCategory).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      {!list ? <p role="status">Загружаем…</p> : list.items.length === 0 ? <div className="empty"><h3>Обращений нет</h3><p>Когда жилец напишет из приложения, обращение появится здесь.</p></div> :
        <ul className="ticket-list">{list.items.map(t => <li key={t.id}><Link href={`/tickets/${t.id}`} className="ticket-row">
          <span className={`status-pill ticket-${t.status.toLowerCase()}`}>{ticketStatus[t.status]}</span>
          <strong>{t.title}</strong>
          <small>{ticketCategory[t.category]}{t.room ? ` · комната ${t.room}` : ''}{t.author ? ` · ${t.author.fullName}` : ''} · {when(t.updatedAt)} · сообщений: {t.messages}</small>
        </Link></li>)}</ul>}
      {list && list.total > list.pageSize && <div className="resident-actions"><button className="button secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button><button className="button secondary" disabled={page * list.pageSize >= list.total} onClick={() => setPage(p => p + 1)}>Дальше</button></div>}
    </> : !detail ? <p role="status">Загружаем…</p> : <>
      <Link href="/tickets" className="back-link">Все обращения</Link>
      <section className="panel ticket-detail">
        <p><span className={`status-pill ticket-${detail.status.toLowerCase()}`}>{ticketStatus[detail.status]}</span> {ticketCategory[detail.category]}{detail.room ? ` · комната ${detail.room}` : ''}</p>
        <h2>{detail.title}</h2>
        {detail.author ? <p>Автор: <Link href={`/residents/${detail.author.residentId}`}>{detail.author.fullName}</Link></p> : <p className="form-hint">Автор скрыт. Его видит только владелец.</p>}
        <ol className="ticket-thread">{detail.thread.map(m => <li key={m.id} className={m.author === 'STAFF' ? 'staff' : 'tenant'}><div><strong>{m.name}</strong><time>{when(m.createdAt)}</time></div><p>{m.body}</p></li>)}</ol>
        {canManage && (open ? <form onSubmit={send}><label>Ответ жильцу<textarea value={reply} maxLength={4000} required onChange={e => setReply(e.target.value)} placeholder="Жилец увидит ответ от имени администрации"/></label>
          <div className="resident-actions"><button className="button primary" disabled={busy || !reply.trim()}>Отправить ответ</button>
            {detail.status === 'OPEN' && <button type="button" className="button secondary" disabled={busy} onClick={() => void setTo('IN_PROGRESS')}>Взять в работу</button>}
            <button type="button" className="button secondary" disabled={busy} onClick={() => void setTo('RESOLVED')}>Решено</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => void setTo('REJECTED')}>Отклонить</button></div></form>
          : <div className="resident-actions"><button className="button secondary" disabled={busy} onClick={() => void setTo('OPEN')}>Открыть снова</button></div>)}
      </section>
    </>}
  </div>;
}
