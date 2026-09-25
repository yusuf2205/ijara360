'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowRight, BedDouble, Building2, Check, ChevronRight, CircleHelp, DoorOpen, History, LayoutDashboard, LogOut, MapPin, Plus, Search, Settings2, ShieldCheck, Users, X } from 'lucide-react';
import { api, ApiError, type Activity, type Property, type Room, type User, type Resident } from '../lib/api';

import { ResidentsPanel, ResidentFlow, dateLabel, money, type ResidentAction } from './residents';

type View = 'overview' | 'rooms' | 'room' | 'history' | 'settings' | 'residents' | 'resident';
type Modal = 'room' | 'edit-room' | 'bed' | 'admin' | 'password' | null;
const titles: Record<View, string> = { residents: 'Жильцы', resident: 'Жилец', overview: 'Обзор дома', rooms: 'Комнаты', room: 'Комнаты', history: 'История действий', settings: 'Настройки' };
const actionLabels: Record<string,string> = { RESIDENT_CREATED: 'Добавлен жилец', RESIDENT_UPDATED: 'Изменены данные жильца', OCCUPANCY_CHECKED_IN: 'Жилец заселён', OCCUPANCY_TRANSFERRED: 'Жилец переселён', OCCUPANCY_CHECKED_OUT: 'Жилец выселен', SETUP_COMPLETED: 'Дом настроен', ROOM_CREATED: 'Добавлена комната', ROOM_UPDATED: 'Изменена комната', BED_CREATED: 'Добавлено место', PROPERTY_UPDATED: 'Изменены данные дома', ADMIN_CREATED: 'Добавлен управляющий', ADMIN_ACCESS_CHANGED: 'Изменён доступ сотрудника', LOGIN: 'Вход в систему', PASSWORD_CHANGED: 'Пароль изменён' };

function ModalDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="modal" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal-content"><header><h2>{title}</h2><button aria-label="Закрыть" className="icon-button" onClick={close}><X size={20}/></button></header>{children}</div>
  </dialog>;
}

export default function Workspace({ view, roomId, capacityOnly = false, residentId, residentFilter }: { view: View; roomId?: string; capacityOnly?: boolean; residentId?: string; residentFilter?: string }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [property, setProperty] = useState<Property | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [residentAction, setResidentAction] = useState<ResidentAction|null>(null);
  const occupiedBeds = rooms.reduce((n,r)=>n+r.occupiedBeds,0);
  const [staff, setStaff] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const currentRoom = rooms.find(r => r.id === roomId);
  const owner = user?.role === 'OWNER';
  const totalBeds = rooms.reduce((n, r) => n + r.totalBeds, 0);
  const totalCapacity = rooms.reduce((n, r) => n + r.capacity, 0);

  async function refresh() {
    try {
      const account = await api<User>('/auth/me');
      const [p, r, a, people] = await Promise.all([api<Property>('/property'), api<Room[]>('/rooms'), api<Activity[]>('/audit'), api<Resident[]>('/residents')]);
      setResidents(people);
      setUser(account); setProperty(p); setRooms(r); setActivity(a);
      if (view === 'settings' && account.role === 'OWNER') setStaff(await api<User[]>('/users'));
      setUpdatedAt(new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }));
      setLoaded(true); setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setUser(null); setProperty(null); setRooms([]); router.replace('/login'); }
      else setError((e as Error).message);
    }
  }
  useEffect(() => { void refresh(); }, [view, roomId, residentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); } }, [toast]);
  function open(kind: Modal) { setFormError(''); setModal(kind); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError('');
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) || '');
    try {
      if (modal === 'room') await api('/rooms', { method: 'POST', body: JSON.stringify({ number: value('number'), capacity: Number(value('capacity')), bedCount: Number(value('bedCount')) }) });
      if (modal === 'edit-room' && currentRoom) await api(`/rooms/${currentRoom.id}`, { method: 'PATCH', body: JSON.stringify({ number: value('number'), capacity: Number(value('capacity')), version: currentRoom.version }) });
      if (modal === 'bed' && currentRoom) await api(`/rooms/${currentRoom.id}/beds`, { method: 'POST', body: JSON.stringify({ number: value('number') }) });
      if (modal === 'admin') await api('/users', { method: 'POST', body: JSON.stringify({ fullName: value('fullName'), phone: value('phone'), password: value('password') }) });
      if (modal === 'password') {
        await api('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: value('currentPassword'), newPassword: value('newPassword') }) });
        router.replace('/login'); return;
      }
      setModal(null); setToast('Изменения сохранены'); await refresh();
    } catch(e) { setFormError((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); router.replace('/login'); } catch (e) { setError((e as Error).message); } }
  async function changeAccess(member: User) {
    setBusy(true);
    try { await api(`/users/${member.id}`, { method: 'PATCH', body: JSON.stringify({ active: !member.active }) }); await refresh(); setToast('Доступ обновлён'); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function saveProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true);
    try { await api('/property', { method: 'PATCH', body: JSON.stringify({ name: form.get('name'), address: form.get('address') }) }); await refresh(); setToast('Данные дома сохранены'); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const filtered = rooms.filter(r => (!capacityOnly || r.totalBeds < r.capacity) && r.number.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="brand"><span className="brand-mark"><Building2 size={23}/></span>ijara<span>360</span></Link>
      <div className="property-switch"><span className="property-icon"><Building2 size={19}/></span><div><strong>{property?.name || 'Ваш дом'}</strong><small>Управление объектом</small></div></div>
      <span className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</span>
      <nav aria-label="Основная навигация">
        <Link className={view === 'overview' ? 'active' : ''} href="/"><LayoutDashboard size={20}/>Главная</Link>
        <Link className={view === 'rooms' || view === 'room' ? 'active' : ''} href="/rooms"><Building2 size={20}/>Комнаты<span className="nav-count">{rooms.length}</span></Link>
        <Link className={view === 'residents' || view === 'resident' ? 'active' : ''} href="/residents"><Users size={20}/>Жильцы</Link>
        <Link className={view === 'history' ? 'active' : ''} href="/history"><History size={20}/>История</Link>
      </nav>
      <div className="sidebar-bottom"><div className="foundation-tip"><ShieldCheck size={21}/><strong>Начинаем с порядка</strong><p>Жильцы, комнаты и история проживания всегда под рукой.</p></div>
        <Link className={`settings-link ${view === 'settings' ? 'active' : ''}`} href="/settings"><Settings2 size={19}/>Настройки</Link>
        <div className="sidebar-user"><span className="avatar">{user?.fullName?.slice(0,1) || '·'}</span><div><strong>{user?.fullName || 'Подключение…'}</strong><small>{owner ? 'Владелец' : 'Управляющий'}</small></div><button aria-label="Выйти" className="icon-button" onClick={logout}><LogOut size={18}/></button></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div><Building2 className="mobile-logo" size={22}/><span>Мой дом</span><ChevronRight size={14}/><strong>{titles[view]}</strong></div><div className="connection"><span className={error ? 'dot warning' : 'dot'}/>{error ? 'Нет актуальных данных' : loaded ? 'Сервер подключён' : 'Подключение…'}</div></header>
      <main className="main-content" id="main">
        {error && <div className="error global-error" role="alert">{error}<button className="button secondary" onClick={refresh}>Повторить</button></div>}
        {!loaded ? <div className="loading" role="status"><div className="skeleton title"/><div className="skeleton stats"/><div className="skeleton content"/>{!error && <span>Загружаем ваш дом…</span>}</div> : <>
        {(view === 'overview' || view === 'rooms') && <>
          <div className="page-heading"><div><div className="heading-kicker">{view === 'overview' ? 'ОБЗОР ОБЪЕКТА' : 'КОМНАТЫ И СПАЛЬНЫЕ МЕСТА'}</div><h1>{view === 'overview' ? 'Дом под контролем' : 'Комнаты'}</h1><p>{view === 'overview' ? 'Все комнаты и места — в одном пространстве.' : 'Посмотрите план комнат или добавьте новые места.'}</p></div><div className="resident-actions"><button className="button primary" onClick={()=>setResidentAction({mode:'check-in'})}><Plus size={19}/>Заселить</button>{owner && <button className="button secondary" onClick={() => open('room')}>Добавить комнату</button>}</div></div>
          <div className="stats-grid">
            <Link href="/rooms" className="stat"><div><span>Комнат</span><Building2 size={21}/></div><strong>{rooms.length}<ArrowRight size={20}/></strong><small>В вашем доме</small></Link>
            <Link href="/rooms" className="stat"><div><span>Спальных мест</span><BedDouble size={22}/></div><strong>{totalBeds}<ArrowRight size={20}/></strong><small>Создано и готово к учёту</small></Link>
            <Link href="/rooms" className="stat accent"><div><span>Свободных мест</span><DoorOpen size={22}/></div><strong>{totalBeds-occupiedBeds}<ArrowRight size={20}/></strong><small><span className="dot"/> По данным системы</small></Link>
            <Link href="/residents?filter=active" className="stat"><div><span>Занято мест</span><Users size={22}/></div><strong>{occupiedBeds}<ArrowRight size={20}/></strong><small>Активные проживания</small></Link>
            <Link href="/residents?filter=active" className="stat"><div><span>Жильцов сейчас</span><Users size={22}/></div><strong>{occupiedBeds}<ArrowRight size={20}/></strong><small>Сейчас живут в доме</small></Link>
            <Link href="/rooms?filter=space" className="stat"><div><span>Можно добавить</span><Plus size={22}/></div><strong>{totalCapacity - totalBeds}<ArrowRight size={20}/></strong><small>В пределах вместимости</small></Link>
          </div>
          {view === 'overview' && <div className="setup-banner"><span className="banner-icon"><ShieldCheck size={25}/></span><div><strong>Кто живёт в доме — видно сразу</strong><p>Заселяйте на свободные места, переселяйте и сохраняйте историю проживания.</p></div><span className="phase-badge">Учёт проживания</span></div>}
          <section className="room-section"><div className="section-heading"><div><h2>{capacityOnly ? "Можно добавить места" : "Ваши комнаты"} <span>{capacityOnly ? filtered.length : rooms.length}</span></h2><p>Каждое место на своём месте</p></div><label className="search-field"><Search size={18}/><input aria-label="Найти комнату" placeholder="Найти комнату…" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
            {filtered.length ? <div className="room-grid">{filtered.map(room => <Link href={`/rooms/${room.id}`} className="room-card" key={room.id}>
              <div className="room-card-top"><span className="room-number">{room.number.padStart(2,'0')}</span><span className="status-pill"><span className="dot"/>{room.availableBeds ? "Есть свободные места" : room.totalBeds ? "Все места заняты" : "Места не добавлены"}</span></div>
              <h3>Комната №{room.number}</h3><p>{room.occupiedBeds} / {room.totalBeds} занято · Свободно: {room.availableBeds}</p>
              <div className="mini-beds" aria-label={`${room.availableBeds} свободных мест`}>{room.beds.slice(0,10).map(b => <span className={b.status==='OCCUPIED'?'occupied':''} key={b.id}><BedDouble size={19}/></span>)}{room.beds.length > 10 && <small>+{room.beds.length - 10}</small>}</div>
              <div className="room-card-bottom"><span><strong>{room.availableBeds}</strong> свободно <span className="separator">/</span> <strong>{room.occupiedBeds}</strong> занято</span><span className="arrow-circle"><ArrowRight size={17}/></span></div>
            </Link>)}</div> : <div className="empty"><Building2 size={38}/><h3>{query ? 'Комната не найдена' : 'Здесь появятся ваши комнаты'}</h3><p>{query ? 'Попробуйте другой номер.' : 'Добавьте первую комнату и укажите количество мест.'}</p>{!query && owner && <button className="button primary" onClick={() => open('room')}>Добавить комнату</button>}</div>}
          </section>
          {view === 'overview' && <section className="recent-section"><div className="section-heading"><div><h2>Последние действия</h2><p>История изменений в вашем доме</p></div><Link className="inline-link" href="/history">Вся история <ArrowRight size={16}/></Link></div><ActivityList items={activity.slice(0,4)}/></section>}
        </>}
        {view === 'room' && (currentRoom ? <>
          <Link className="back-link" href="/rooms"><ArrowLeft size={16}/>Все комнаты</Link>
          <div className="page-heading"><div><div className="heading-kicker">СПАЛЬНЫЕ МЕСТА</div><h1>Комната №{currentRoom.number}</h1><p>{currentRoom.totalBeds} мест создано · Вместимость {currentRoom.capacity}</p></div>{owner && <button className="button secondary" onClick={() => open('edit-room')}><Settings2 size={17}/>Изменить комнату</button>}</div>
          <div className="room-summary"><div><span className="dot"/><strong>{currentRoom.availableBeds}</strong> свободно</div><div><span className="dot neutral"/><strong>{currentRoom.occupiedBeds}</strong> занято</div><span>По активным проживаниям</span></div>
          <div className="bed-grid">{currentRoom.beds.map(bed => <article className={`bed-card ${bed.occupancy?'occupied-bed':''}`} key={bed.id}><div className="bed-card-top"><span>{bed.displayNumber}</span><span className="status-pill"><span className="dot"/>{bed.occupancy?'Занято':'Свободно'}</span></div><BedDouble size={38} strokeWidth={1.2}/><h3>Место {bed.number}</h3>{bed.occupancy ? <Link className="bed-resident" href={`/residents/${bed.occupancy.residentId}`}><strong>{bed.occupancy.resident?.fullName}</strong><span>{bed.occupancy.resident?.phone}</span><span>С {dateLabel(bed.occupancy.moveInDate)}</span><span>{money(bed.occupancy.monthlyPrice)} / мес.</span><span className="inline-link">Открыть жильца <ArrowRight size={14}/></span></Link> : <button className="button primary" onClick={()=>setResidentAction({mode:'check-in',bedId:bed.id})}>Заселить</button>}</article>)}
            {owner && currentRoom.totalBeds < currentRoom.capacity && <button className="bed-add" onClick={() => open('bed')}><Plus size={28}/><strong>Добавить место</strong><span>Ещё {currentRoom.capacity - currentRoom.totalBeds} в пределах вместимости</span></button>}
          </div>
          {owner && currentRoom.totalBeds === currentRoom.capacity && <p className="helper-line"><CircleHelp size={17}/>Все места созданы. Чтобы добавить ещё, увеличьте вместимость комнаты.</p>}
        </> : <div className="empty"><h1>Комната не найдена</h1><Link href="/rooms">Вернуться к комнатам</Link></div>)}
        {(view === 'residents' || view === 'resident') && <ResidentsPanel residents={residents} residentId={residentId} onAction={setResidentAction} initialFilter={residentFilter}/>}
        {view === 'history' && <><div className="page-heading"><div><div className="heading-kicker">ПРОЗРАЧНЫЙ УЧЁТ</div><h1>История действий</h1><p>Кто и когда менял данные. Последние 100 действий.</p></div></div><ActivityList items={activity}/></>}
        {view === 'settings' && <>
          <div className="page-heading"><div><div className="heading-kicker">ВАШЕ ПРОСТРАНСТВО</div><h1>Настройки</h1><p>Данные дома и доступ сотрудников.</p></div></div>
          <div className="settings-grid"><section className="panel"><div className="panel-heading"><Building2 size={22}/><h2>Ваш дом</h2></div><form onSubmit={saveProperty} key={property?.name}><label>Название дома<input name="name" defaultValue={property?.name} required maxLength={120} disabled={!owner}/></label><label>Адрес<input name="address" defaultValue={property?.address || ''} maxLength={500} disabled={!owner}/></label>{owner && <button className="button primary" disabled={busy}>Сохранить</button>}</form></section>
          <section className="panel"><div className="panel-heading"><ShieldCheck size={22}/><h2>Моя учётная запись</h2></div><div className="account-details"><span className="avatar large">{user?.fullName.slice(0,1)}</span><div><strong>{user?.fullName}</strong><p>{user?.phone}</p><span className="status-pill">{owner ? 'Владелец' : 'Управляющий'}</span></div></div><div className="account-actions"><button className="button secondary" onClick={() => open('password')}>Изменить пароль</button><button className="button text" onClick={logout}><LogOut size={16}/>Выйти из аккаунта</button></div></section></div>
          {owner && <section className="panel staff-panel"><div className="section-heading"><div><h2>Сотрудники</h2><p>Только владелец может управлять доступом</p></div><button className="button secondary" onClick={() => open('admin')}><Plus size={17}/>Управляющий</button></div><div className="staff-list">{staff.map(member => <div className="staff-row" key={member.id}><span className="avatar">{member.fullName.slice(0,1)}</span><div><strong>{member.fullName}</strong><small>{member.phone} · {member.role === 'OWNER' ? 'Владелец' : member.active ? 'Управляющий' : 'Доступ отключён'}</small></div>{member.role === 'ADMIN' && <button disabled={busy} className="button text" onClick={() => changeAccess(member)}>{member.active ? 'Отключить' : 'Включить'}</button>}</div>)}</div></section>}
        </>}
        <footer className="page-footer"><span><ShieldCheck size={14}/>Данные сохранены на вашем сервере</span><span>Обновлено в {updatedAt}</span></footer>
        </>}
      </main>
      <nav className="mobile-nav" aria-label="Мобильная навигация"><Link className={view === 'overview' ? 'active' : ''} href="/"><LayoutDashboard size={21}/>Главная</Link><Link className={view === 'rooms' || view === 'room' ? 'active' : ''} href="/rooms"><Building2 size={21}/>Комнаты</Link><Link className={view === 'residents' || view === 'resident' ? 'active' : ''} href="/residents"><Users size={21}/>Жильцы</Link><Link className={view === 'history' ? 'active' : ''} href="/history"><History size={21}/>История</Link><Link className={view === 'settings' ? 'active' : ''} href="/settings"><Settings2 size={21}/>Настройки</Link></nav>
    </div>
    {residentAction && <ResidentFlow action={residentAction} rooms={rooms} residents={residents} close={()=>setResidentAction(null)} saved={async id=>{await refresh();setToast('Данные сохранены');if(id&&(residentAction.mode==='create'||residentAction.mode==='check-in'&&view!=='room'))router.push(`/residents/${id}`);}}/>}
    {toast && <div className="toast" role="status"><Check size={19}/>{toast}</div>}
    {modal && <ModalDialog close={() => { if (!busy) setModal(null); }} title={{ room: 'Новая комната', 'edit-room': 'Изменить комнату', bed: 'Новое спальное место', admin: 'Добавить управляющего', password: 'Изменить пароль' }[modal]}>
      <form onSubmit={save}>
        {(modal === 'room' || modal === 'edit-room') && <><label>Номер комнаты<input name="number" required maxLength={20} defaultValue={modal === 'edit-room' ? currentRoom?.number : ''} placeholder="Например, 8" autoFocus/></label><div className="form-grid"><label>Вместимость<input name="capacity" type="number" required min={1} max={100} defaultValue={modal === 'edit-room' ? currentRoom?.capacity : 8}/></label>{modal === 'room' && <label>Создать мест<input name="bedCount" type="number" required min={0} max={100} defaultValue={8}/></label>}</div><p className="form-hint">У каждого места будет собственный номер. Данные сохранятся в истории.</p></>}
        {modal === 'bed' && <><label>Номер места<input name="number" required maxLength={20} placeholder="Например, 9" autoFocus/></label><p className="form-hint">Комната №{currentRoom?.number}. Новое место будет свободным.</p></>}
        {modal === 'admin' && <><label>ФИО<input name="fullName" required maxLength={160} autoFocus/></label><label>Телефон<input name="phone" type="tel" required placeholder="+998 90 123 45 67"/></label><label>Начальный пароль<input name="password" type="password" required minLength={15} maxLength={128} autoComplete="new-password"/></label><p className="form-hint">Не менее 15 символов. Передайте пароль лично; управляющий сможет сменить его в настройках.</p></>}
        {modal === 'password' && <><label>Текущий пароль<input name="currentPassword" type="password" required autoComplete="current-password" autoFocus/></label><label>Новый пароль<input name="newPassword" type="password" minLength={15} maxLength={128} required autoComplete="new-password"/></label><p className="form-hint">После сохранения потребуется войти заново на всех устройствах.</p></>}
        {formError && <div className="error" role="alert">{formError}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setModal(null)}>Отмена</button><button className="button primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div>
      </form>
    </ModalDialog>}
  </div>;
}

function ActivityList({ items }: { items: Activity[] }) {
  if (!items.length) return <div className="empty compact"><History size={25}/><p>Пока нет действий. Все изменения появятся здесь.</p></div>;
  return <div className="activity-list">{items.map(item => <div className="activity-row" key={item.id}><span className="activity-icon">{item.entity === 'User' ? <Users size={18}/> : <Building2 size={18}/>}</span><div><strong>{actionLabels[item.action] || item.action}{typeof item.metadata.number === 'string' && ` №${item.metadata.number}`}</strong><small>{item.actor.fullName}</small></div><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tashkent' })}</time></div>)}</div>;
}
