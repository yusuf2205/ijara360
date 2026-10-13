'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, CheckCheck, FileText, MessageSquare, Wallet } from 'lucide-react';
import { api } from '../lib/api';

type Item = { id: string; kind: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };
type Feed = { items: Item[]; total: number; unread: number; page: number; pageSize: number };
const when = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const icon = (kind: string) => kind.startsWith('TICKET') ? <MessageSquare size={18}/> : kind.startsWith('APPLICATION') ? <FileText size={18}/> : kind.startsWith('PAYMENT') || kind.startsWith('CHARGE') ? <Wallet size={18}/> : <Bell size={18}/>;
const tone = (kind: string) => kind.startsWith('TICKET') ? 'c-violet' : kind.startsWith('APPLICATION') ? 'c-orange' : 'c-blue';

export function NotificationsPanel({ onChange }: { onChange?: () => void }) {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  async function load() { try { setFeed(await api<Feed>(`/notifications?page=${page}`)); setError(''); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void load(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  async function read(ids?: string[]) { await api('/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }); onChange?.(); await load(); }
  async function open(n: Item) { try { if (!n.readAt) await read([n.id]); if (n.link) router.push(n.link); } catch (e) { setError((e as Error).message); } }
  return <>
    <div className="page-heading"><div><div className="heading-kicker">ЛЕНТА</div><h1>Уведомления</h1><p>Новые заявки, обращения и сообщения жильцов.</p></div>{feed && feed.unread > 0 && <button className="button secondary" onClick={() => void read().catch(e => setError((e as Error).message))}><CheckCheck size={17}/>Прочитать все</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {!feed ? <p role="status">Загружаем…</p> : feed.items.length === 0 ? <div className="empty"><Bell size={34}/><h3>Уведомлений пока нет</h3><p>Здесь появятся новые заявки и обращения жильцов.</p></div> :
      <ul className="notice-list">{feed.items.map(n => <li key={n.id}><button className={`notice-row ${n.readAt ? '' : 'unread'}`} onClick={() => void open(n)}>
        <span className={`chip ${tone(n.kind)}`}>{icon(n.kind)}</span><span className="notice-text"><strong>{n.title}</strong><small>{n.body}</small></span><time dateTime={n.createdAt}>{when(n.createdAt)}</time>{!n.readAt && <span className="unread-dot" aria-label="Не прочитано"/>}
      </button></li>)}</ul>}
    {feed && feed.total > feed.pageSize && <div className="resident-actions"><button className="button secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button><button className="button secondary" disabled={page * feed.pageSize >= feed.total} onClick={() => setPage(p => p + 1)}>Дальше</button></div>}
  </>;
}
