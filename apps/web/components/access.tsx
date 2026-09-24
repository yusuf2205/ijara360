'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, ShieldCheck, Check, BedDouble } from 'lucide-react';
import { api } from '../lib/api';

export default function Access() {
  const router = useRouter();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('Мой студенческий дом');
  const [address, setAddress] = useState('');
  const [rooms, setRooms] = useState(7);
  const [beds, setBeds] = useState(8);
  const check = () => api<{configured: boolean}>('/auth/setup-status').then(r => { setConfigured(r.configured); setError(''); }).catch(e => setError(e.message));
  useEffect(() => { void check(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!configured && step === 1) { setStep(2); return; }
    setBusy(true);
    try {
      if (!configured) {
        await api('/auth/setup', { method: 'POST', headers: { 'X-Setup-Token': token }, body: JSON.stringify({ phone, password, fullName, propertyName: name, address,
          rooms: Array.from({ length: rooms }, (_, i) => ({ number: String(i + 1), capacity: beds })) }) });
        // Setup is committed already. A failed login must not retry setup.
        setConfigured(true);
      }
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ phone, password }) });
      router.replace('/');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="access-page">
    <section className="access-story">
      <div className="brand light"><span className="brand-mark"><Building2 size={24} /></span>ijara<span>360</span></div>
      <div><span className="eyebrow light">ВАШ ДОМ. ВСЁ НА СВОИХ МЕСТАХ.</span><h1>Меньше записей.<br />Больше порядка.</h1><p>Один понятный инструмент для управления студенческим домом.</p>
        <div className="story-rooms" aria-hidden="true">{[1,2,3].map(n => <div key={n}><Building2 size={23}/><strong>Комната {n}</strong><div>{[1,2,3,4].map(b => <BedDouble size={20} key={b}/>)}</div><span><Check size={13}/> Всё под контролем</span></div>)}</div>
      </div>
      <span className="story-foot"><ShieldCheck size={17}/> Данные хранятся на вашем сервере</span>
    </section>
    <section className="access-form-area">
      <div className="access-mobile-brand brand"><Building2/> ijara360</div>
      <div className="access-card">
        <div className="access-icon"><Building2 size={27}/></div>
        <span className="eyebrow">{configured ? 'С ВОЗВРАЩЕНИЕМ' : 'НАЧНЁМ С ОСНОВНОГО'}</span>
        <h2>{configured ? 'Войти в свой дом' : 'Настроить Ijara360'}</h2>
        <p className="muted">{configured ? 'Укажите телефон и пароль вашей учётной записи.' : 'Создайте владельца и добавьте комнаты. Это займёт пару минут.'}</p>
        {configured === null ? <div className="notice">{error || 'Подключаемся к серверу…'}{error && <button className="button secondary" onClick={check}>Повторить</button>}</div> :
        <form onSubmit={submit}>
          {!configured && <div className="steps"><span className={step === 1 ? 'current' : ''}>1. Владелец</span><span className={step === 2 ? 'current' : ''}>2. Дом и комнаты</span></div>}
          {(configured || step === 1) ? <>
            {!configured && <><label>Ключ первоначальной настройки<input value={token} onChange={e => setToken(e.target.value)} type="password" required minLength={32} autoComplete="off"/><small>Ключ находится в файле доступа, подготовленном при установке.</small></label>
            <label>Ваше имя<input value={fullName} onChange={e => setFullName(e.target.value)} required maxLength={160} autoComplete="name"/></label></>}
            <label>Телефон<input value={phone} onChange={e => setPhone(e.target.value)} type="tel" placeholder="+998 90 123 45 67" required autoComplete="username" /></label>
            <label>Пароль<input value={password} onChange={e => setPassword(e.target.value)} type="password" required minLength={configured ? 1 : 15} maxLength={128} autoComplete={configured ? 'current-password' : 'new-password'} />{!configured && <small>Не менее 15 символов. Можно использовать длинную фразу.</small>}</label>
          </> : <>
            <label>Название дома<input value={name} onChange={e => setName(e.target.value)} required maxLength={120}/></label>
            <label>Адрес <span className="optional">необязательно</span><input value={address} onChange={e => setAddress(e.target.value)} maxLength={500}/></label>
            <div className="form-grid"><label>Количество комнат<input type="number" value={rooms} min={1} max={30} required onChange={e => setRooms(Number(e.target.value))}/></label><label>Мест в каждой<input type="number" value={beds} min={1} max={100} required onChange={e => setBeds(Number(e.target.value))}/></label></div>
            <div className="notice">Будет создано {rooms} комнат и {rooms * beds} свободных мест. Настройки отдельных комнат можно изменить позже.</div>
          </>}
          {error && <div className="error" role="alert">{error}</div>}
          <button className="button primary wide" disabled={busy}>{busy ? 'Сохраняем…' : configured ? 'Войти' : step === 1 ? 'Продолжить' : 'Создать дом'}<ArrowRight size={18}/></button>
          {!configured && step === 2 && <button className="button text wide" type="button" onClick={() => setStep(1)}>Назад</button>}
        </form>}
        <p className="access-caption">Доступ только для владельца и управляющего.<br/>Роль определяется вашей учётной записью.</p>
      </div>
      <span className="access-footer">Ijara360 · Управление домом без лишних забот</span>
    </section>
  </main>;
}
