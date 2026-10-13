'use client';
import { Logo } from './brand';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';

type Info = { firstName: string; propertyName: string; phone: string; expiresAt: string };

/** One-time invite: the token lives in the URL fragment, so it never reaches server logs or referrers. */
export default function Invite() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    const t = window.location.hash.slice(1);
    // Drop the token from the address bar and history as soon as it is read.
    window.history.replaceState(null, '', window.location.pathname);
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(t)) { setError('Ссылка неполная. Откройте её из сообщения целиком.'); return; }
    setToken(t);
    api<Info>('/tenant/invites/inspect', { method: 'POST', body: JSON.stringify({ token: t }) }).then(setInfo).catch(e => setError((e as Error).message));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (password !== repeat) { setError('Пароли не совпадают.'); return; }
    setBusy(true);
    try { setDone((await api<{ phone: string }>('/tenant/invites/accept', { method: 'POST', body: JSON.stringify({ token, password }) })).phone); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="apply-shell"><header><span className="apply-brand"><Logo size={28}/></span><span>{info?.propertyName || 'Приложение жильца'}</span></header>
    <section className="apply-card">
      <h1>{done ? 'Пароль задан' : info ? `${info.firstName}, задайте пароль` : 'Приложение жильца'}</h1>
      {error && <div className="error" role="alert">{error}</div>}
      {done ? <><p>Теперь войдите в приложение Ijara360 по номеру <strong>{done}</strong> и новому паролю.</p><p className="form-hint">Если вы уже входили раньше, на других устройствах нужно будет войти заново.</p></>
        : info ? <form onSubmit={submit}>
          <p>Вход в приложение — по вашему номеру {info.phone}. Ссылка одноразовая и действует до {new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(info.expiresAt))}.</p>
          <label>Новый пароль<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)}/></label>
          <label>Повторите пароль<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={repeat} onChange={e => setRepeat(e.target.value)}/></label>
          <p className="form-hint">Не менее 10 символов. Можно использовать фразу из нескольких слов.</p>
          <button className="button primary" disabled={busy}>Сохранить пароль</button>
        </form> : !error && <p role="status">Проверяем ссылку…</p>}
    </section><footer>Никому не сообщайте пароль. Администрация его не спросит.</footer></main>;
}
