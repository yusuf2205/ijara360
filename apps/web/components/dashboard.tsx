'use client';
import { LocationSummary } from './map';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Banknote, BedDouble, Bot, Building2, Cctv, CheckCircle2, CircleAlert, FileText, House, Send, UserMinus, UserPlus, Users, Wallet } from 'lucide-react';
import { api, type Room } from '../lib/api';
import { useRealtime } from '../lib/realtime';

type Summary = { charged: string; paid: string; outstanding: string; overdue: string; blockedResidents: number };
type Group = { residents: number; amount: string };
type Month = { month: string; paid: Group; partial: Group; unpaid: Group; received: string; months: { month: string; received: string }[] };
type Extra = { finance?: Summary & { debtors: number }; month?: Month; applications?: number; today?: { movedIn: number; movedOut: number } };

const sum = (v: string | number) => Math.round(Number(v)).toLocaleString('ru-RU') + ' сум';
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
}
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', ...o }).format(new Date());
const monthName = (m: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'short' }).format(new Date(`${m}-01T00:00:00Z`)).replace('.', '');

/** A tile for a module that is not built yet: shown in place, marked «скоро», never with invented numbers. */
const Soon = () => <span className="soon-badge">скоро</span>;

/** Owner and staff home, as on the owner's mockups (2026-10-17): numbers first, then occupancy, money,
 *  cameras (soon), the house plan, recent events and the assistant (soon). Phones get the tile grid instead. */
export function Dashboard({ name, rooms, residents, permissions, actions, events }: { name: string; rooms: Room[]; residents: number; permissions: string[]; actions: ReactNode; events: ReactNode }) {
  const [extra, setExtra] = useState<Extra>({});
  const can = (p: string) => permissions.includes(p);
  const [tick, setTick] = useState(0);
  const [, setClock] = useState(0);
  useRealtime(['finance', 'applications', 'house'], () => setTick(t => t + 1));
  useEffect(() => { const t = setInterval(() => setClock(c => c + 1), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      const next: Extra = {};
      // Each block appears only for staff who may see it; a failed block stays hidden instead of breaking the page.
      await Promise.all([
        can('FINANCE_VIEW') && api<{ summary: Summary; residents: { totalDebt: string }[] }>('/finance').then(f => { next.finance = { ...f.summary, debtors: f.residents.filter(r => Number(r.totalDebt) > 0).length }; }).catch(() => undefined),
        can('FINANCE_VIEW') && api<Month>('/finance/month').then(m => { next.month = m; }).catch(() => undefined),
        can('APPLICATION_VIEW') && api<{ counts: Record<string, number> }>('/applications?status=SUBMITTED').then(a => { next.applications = a.counts.SUBMITTED || 0; }).catch(() => undefined),
        api<{ movedIn: number; movedOut: number }>('/occupancies/today').then(t => { next.today = t; }).catch(() => undefined),
      ]);
      if (live) setExtra(next);
    })();
    return () => { live = false; };
  }, [permissions.join(','), tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const beds = rooms.reduce((n, r) => n + r.totalBeds, 0);
  const busy = rooms.reduce((n, r) => n + r.occupiedBeds, 0);
  const pct = beds ? Math.round(busy / beds * 100) : 0;
  const ring = 2 * Math.PI * 52;
  const { finance: f, month: m, today: t } = extra;
  const peak = m ? Math.max(1, ...m.months.map(x => Number(x.received))) : 1;

  type Kpi = { href?: string; icon: ReactNode; tone: string; value?: ReactNode; label: string; soon?: boolean };
  const kpis: Kpi[] = [
    { href: '/rooms', icon: <BedDouble size={18} />, tone: 'c-blue', value: beds, label: 'Всего мест' },
    { href: '/residents?filter=active', icon: <Users size={18} />, tone: 'c-red', value: busy, label: 'Занято' },
    { href: '/rooms', icon: <CheckCircle2 size={18} />, tone: 'c-green', value: beds - busy, label: 'Свободно' },
    { icon: <House size={18} />, tone: 'c-green', label: 'Дома сейчас', soon: true },
    { icon: <UserMinus size={18} />, tone: 'c-blue', label: 'Не дома', soon: true },
  ];
  if (f) kpis.push({ href: '/finance', icon: <AlertCircle size={18} />, tone: 'c-orange', value: f.debtors, label: 'Должники' });
  if (extra.applications !== undefined) kpis.push({ href: '/applications?status=SUBMITTED', icon: <FileText size={18} />, tone: 'c-red', value: extra.applications, label: 'Новые заявки' });

  // Phone tiles (mockup "Главная (Dashboard)").
  type Tile = { href: string; icon: ReactNode; tone: string; value: ReactNode; label: string; wide?: boolean };
  const tiles: Tile[] = [
    { href: '/rooms', icon: <Building2 size={18} />, tone: 't-blue', value: rooms.length, label: 'Комнаты' },
    { href: '/rooms', icon: <BedDouble size={18} />, tone: 't-green', value: beds, label: 'Мест всего' },
    { href: '/residents?filter=active', icon: <Users size={18} />, tone: 't-red', value: busy, label: 'Занято' },
    { href: '/rooms', icon: <CheckCircle2 size={18} />, tone: 't-green', value: beds - busy, label: 'Свободно' },
    { href: '/residents', icon: <Users size={18} />, tone: 't-blue', value: residents, label: 'Жильцы' },
  ];
  if (m) tiles.push(
    { href: '/finance', icon: <CheckCircle2 size={18} />, tone: 't-green', value: m.paid.residents, label: 'Оплатили' },
    { href: '/finance', icon: <CircleAlert size={18} />, tone: 't-red', value: m.unpaid.residents + m.partial.residents, label: 'Не оплатили' });
  if (f) tiles.push({ href: '/finance', icon: <Wallet size={18} />, tone: 't-orange', value: sum(f.outstanding), label: 'Общий долг' });
  if (m) tiles.push({ href: '/finance', icon: <Banknote size={18} />, tone: 't-green', value: sum(m.received), label: 'Получено за месяц', wide: true });

  return <div className="dashboard">
    <div className="page-heading hello">
      <div><div className="hello-kicker">Здравствуйте,</div><h1><span className="hello-greet">{greeting()}, </span>{name.split(' ')[0]}!</h1><p>Вот что происходит в вашем доме сегодня.</p><p className="hello-date">Сегодня, {fmt({ day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
      <div className="hello-side"><div className="hello-clock"><small>{fmt({ weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</small><strong>{fmt({ hour: '2-digit', minute: '2-digit' })}</strong></div><div className="resident-actions">{actions}</div></div>
    </div>

    <div className="tiles-mobile">
      {tiles.map(x => <Link href={x.href} className={`tile ${x.tone} ${x.wide ? 'wide' : ''}`} key={x.label}><span className="tile-icon">{x.icon}</span><span><small>{x.label}</small><strong>{x.value}</strong></span></Link>)}
      {t && <><h2 className="tiles-title">Сегодня</h2>
        <Link href="/residents?filter=active" className="tile t-blue"><span className="tile-icon"><UserPlus size={18} /></span><span><small>Заселились</small><strong>{t.movedIn}</strong></span></Link>
        <Link href="/residents?filter=closed" className="tile t-red"><span className="tile-icon"><UserMinus size={18} /></span><span><small>Выселились</small><strong>{t.movedOut}</strong></span></Link></>}
    </div>

    <div className="stats-grid kpis">{kpis.map(k => {
      const body = <><span className="kpi-row"><span className={`chip ${k.tone}`}>{k.icon}</span><strong>{k.soon ? '—' : k.value}</strong></span><small>{k.label}{k.soon && <> <Soon /></>}</small></>;
      return k.href ? <Link href={k.href} className="stat kpi" key={k.label}>{body}</Link> : <div className="stat kpi soon" key={k.label} aria-label={`${k.label}: скоро`}>{body}</div>;
    })}</div>

    <div className="dash-grid">
      <section className="card"><h2>Заполняемость дома</h2><div className="occupancy">
        <svg viewBox="0 0 130 130" role="img" aria-label={`Занято ${pct}%`}><circle cx="65" cy="65" r="52" className="ring-track" />{pct > 0 && <circle cx="65" cy="65" r="52" className="ring-value" strokeDasharray={`${ring * pct / 100} ${ring}`} transform="rotate(-90 65 65)" />}<text x="65" y="72" textAnchor="middle" className="ring-pct">{pct}%</text></svg>
        <div className="legend"><div><span className="sw busy" />Занято<b>{busy}</b></div><div><span className="sw free" />Свободно<b>{beds - busy}</b></div>{extra.applications !== undefined && <div><span className="sw review" />На рассмотрении<b>{extra.applications}</b></div>}</div>
      </div><p className="occupancy-foot">{busy} из {beds} мест занято</p></section>

      {f ? <section className="card"><h2>Финансовая сводка <Link href="/finance">Подробнее</Link></h2><div className="money-chart">
        <div className="money">
          <div><span className="chip c-blue"><FileText size={17} /></span><p><strong>{sum(f.charged)}</strong><small>Всего начислено</small></p></div>
          <div><span className="chip c-green"><CheckCircle2 size={17} /></span><p><strong>{sum(f.paid)}</strong><small>Оплачено</small></p></div>
          <div><span className="chip c-red"><AlertCircle size={17} /></span><p><strong>{sum(f.outstanding)}</strong><small>Долг{f.debtors ? ` · ${f.debtors} жильцов` : ''}</small></p></div>
        </div>
        {m && <div className="bars" role="img" aria-label={`Получено по месяцам: ${m.months.map(x => `${monthName(x.month)} ${sum(x.received)}`).join(', ')}`}>
          {m.months.map(x => <div key={x.month}><i style={{ height: `${Math.max(3, Number(x.received) / peak * 100)}%` }} className={x.month === m.month ? 'now' : ''} /><small>{monthName(x.month)}</small></div>)}
        </div>}
      </div></section> : <section className="card"><h2>Сегодня</h2><div className="money"><div><span className="chip c-green"><CheckCircle2 size={17} /></span><p><strong>{beds - busy} свободных мест</strong><small>Можно заселять</small></p></div></div></section>}

      <section className="card soon-card"><h2>Камеры и оборудование <Soon /></h2>
        <div className="soon-body"><span className="chip c-blue"><Cctv size={20} /></span><p><strong>Живое видео с камер дома</strong><small>Камеры появятся здесь после подключения. Смотреть смогут только сотрудники с правом доступа.</small></p></div>
        <div className="camera-slots" aria-hidden="true">{[1, 2].map(i => <div key={i}><Cctv size={22} /></div>)}</div>
      </section>
    </div>

    <div className="dash-grid">
      <section className="card"><h2>План дома <Link href="/rooms">Все комнаты</Link></h2>
        {rooms.length ? <div className="plan">{rooms.map(room => {
          const tone = room.totalBeds === 0 ? 'empty' : room.availableBeds === 0 ? 'full' : room.availableBeds <= Math.ceil(room.totalBeds / 4) ? 'almost' : 'free';
          return <Link href={`/rooms/${room.id}`} className={`room-card plan-tile ${tone}`} key={room.id}><h3>Комната №{room.number}</h3><b>{room.occupiedBeds}/{room.totalBeds}</b><small>{room.totalBeds === 0 ? 'Мест нет' : room.availableBeds ? `Свободно ${room.availableBeds}` : 'Мест нет'}</small></Link>;
        })}</div> : <div className="empty"><Building2 size={34} /><h3>Здесь появятся ваши комнаты</h3></div>}
        <p className="plan-legend"><span className="sw full" />Мест нет<span className="sw almost" />Почти заполнена<span className="sw free" />Есть места</p>
      </section>
      <section className="card events-card"><h2>Последние события <Link href="/history">Смотреть все</Link></h2>{events}</section>
      <section className="card soon-card assistant"><h2><span className="ai-title">AI Помощник</span> <Soon /></h2>
        <p className="muted">Задавайте вопросы о доме обычными словами. Примеры:</p>
        <ul className="ai-examples" aria-label="Примеры вопросов">{['Кто сейчас дома?', 'Кто должен больше 7 дней?', 'Покажи новые заявки', 'Есть срочные жалобы?'].map(q => <li key={q}><Bot size={14} />{q}</li>)}</ul>
        <div className="ai-input" aria-hidden="true"><span>Напишите ваш вопрос…</span><Send size={16} /></div>
      </section>
    </div>
    {can('VIEW_LOCATION') && <LocationSummary />}
  </div>;
}
