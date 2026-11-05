'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';

type Guardian = { id: string; name: string; phone: string | null; status: 'PENDING' | 'LINKED'; linkedAt: string | null; linkExpiresAt: string | null };
type Issued = { id: string; link: string; expiresAt: string };
const when = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/**
 * Parent access: staff add a parent and pass on a one-time Telegram link; the parent then gets payment reminders,
 * payments with the receipt number, new charges and stay changes in the bot. Live: the list follows the bot.
 */
export function GuardiansPanel({ residentId, living }: { residentId: string; living: boolean }) {
  const [list, setList] = useState<Guardian[] | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api<{ guardians: Guardian[] }>(`/residents/${residentId}`).then(r => setList(r.guardians ?? [])).catch(e => setError((e as Error).message)), [residentId]);
  useEffect(() => { setIssued(null); setAdding(false); setConfirm(''); void load(); }, [load]);
  useRealtime(['house'], load);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const add = (e: FormEvent) => { e.preventDefault(); void run(async () => { setIssued(await api<Issued>(`/residents/${residentId}/guardians`, { method: 'POST', body: JSON.stringify({ name, phone }) })); setAdding(false); setName(''); setPhone(''); }); };
  const relink = (id: string) => run(async () => { setIssued(await api<Issued>(`/residents/${residentId}/guardians/${id}/link`, { method: 'POST' })); });
  const remove = (id: string) => run(async () => { await api(`/residents/${residentId}/guardians/${id}`, { method: 'DELETE' }); setConfirm(''); if (issued?.id === id) setIssued(null); });
  async function copy(link: string) { try { await navigator.clipboard.writeText(link); setError(''); } catch { setError('Не удалось скопировать. Выделите ссылку вручную.'); } }
  const pending = issued && list?.find(g => g.id === issued.id && g.status === 'PENDING');
  return <section className="panel guardians"><h2>Родители</h2>
    <p className="form-hint">Родитель получает в Telegram напоминания об оплате и просрочке, оплаты с номером чека, новые начисления, переселение, срок проживания и выезд. Местоположение и документы ему не видны.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!list ? <p role="status">Загружаем…</p> : <>
      {list.length ? <ul className="guardian-list">{list.map(g => <li key={g.id} className="guardian-row">
        <div><strong>{g.name}</strong><small>{g.phone ? `${g.phone} · ` : ''}{g.status === 'LINKED' ? `подключён ${when(g.linkedAt!)}` : g.linkExpiresAt ? `ждём, ссылка до ${when(g.linkExpiresAt)}` : 'ссылка истекла'}</small></div>
        <span className={`status-pill ${g.status === 'LINKED' ? 'ok' : ''}`}>{g.status === 'LINKED' ? 'В Telegram' : 'Не подключён'}</span>
        <div className="resident-actions">
          {living && g.status === 'PENDING' && <button className="button secondary" disabled={busy} onClick={() => void relink(g.id)}>Новая ссылка</button>}
          {confirm === g.id
            ? <><button className="button danger" disabled={busy} onClick={() => void remove(g.id)}>Да, отключить</button><button className="button secondary" disabled={busy} onClick={() => setConfirm('')}>Отмена</button></>
            : <button className="button secondary" disabled={busy} onClick={() => setConfirm(g.id)}>Отключить</button>}
        </div>
      </li>)}</ul> : <p className="muted">Родители не подключены.</p>}
      {issued && pending && <div className="invite-link"><p>Отправьте эту ссылку родителю ({pending.name}). Он откроет её в Telegram и сразу будет подключён. Ссылка одноразовая и действует до {when(issued.expiresAt)}.</p><code>{issued.link}</code><button className="button secondary" type="button" onClick={() => void copy(issued.link)}>Скопировать ссылку</button></div>}
      {living ? (adding
        ? <form className="guardian-form" onSubmit={add}>
          <label>Кто это<input required minLength={2} maxLength={80} placeholder="Мама, Дилноза" value={name} onChange={e => setName(e.target.value)} /></label>
          <label>Телефон (необязательно)<input type="tel" maxLength={30} placeholder="+998 90 123 45 67" value={phone} onChange={e => setPhone(e.target.value)} /></label>
          <div className="resident-actions"><button className="button primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Получить ссылку'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setAdding(false)}>Отмена</button></div>
        </form>
        : list.length < 3 && <button className="button primary" disabled={busy} onClick={() => { setAdding(true); setError(''); }}>Подключить родителя</button>)
        : <p className="form-hint">Подключить родителя можно только к жильцу, который сейчас проживает. При выселении родители отключаются автоматически.</p>}
    </>}
  </section>;
}
