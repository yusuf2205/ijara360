'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, BedDouble, Building2, CheckCircle2, DoorOpen, FileText, MessageSquare, Plus, Users } from 'lucide-react';
import { api, type Room } from '../lib/api';

type Summary = { charged: string; paid: string; outstanding: string; overdue: string; blockedResidents: number };
type Extra = { finance?: Summary & { debtors: number }; applications?: number; tickets?: number };

const sum = (v: string | number) => Math.round(Number(v)).toLocaleString('ru-RU') + ' сум';
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
}
const today = () => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

/** Owner and staff home: the numbers first, then occupancy, money, the house plan and recent events. */
export function Dashboard({ name, rooms, permissions, actions, events }: { name: string; rooms: Room[]; permissions: string[]; actions: ReactNode; events: ReactNode }) {
  const [extra, setExtra] = useState<Extra>({});
  const can = (p: string) => permissions.includes(p);
  useEffect(() => {
    let live = true;
    (async () => {
      const next: Extra = {};
      // Each block appears only for staff who may see it; a failed block stays hidden instead of breaking the page.
      await Promise.all([
        can('FINANCE_VIEW') && api<{ summary: Summary; residents: { totalDebt: string }[] }>('/finance').then(f => { next.finance = { ...f.summary, debtors: f.residents.filter(r => Number(r.totalDebt) > 0).length }; }).catch(() => undefined),
        can('APPLICATION_VIEW') && api<{ counts: Record<string, number> }>('/applications?status=SUBMITTED').then(a => { next.applications = a.counts.SUBMITTED || 0; }).catch(() => undefined),
        (can('TICKETS_VIEW') || can('TICKETS_MANAGE')) && api<{ counts: Record<string, number> }>('/tickets?status=OPEN').then(t => { next.tickets = t.counts.OPEN || 0; }).catch(() => undefined),
      ]);
      if (live) setExtra(next);
    })();
    return () => { live = false; };
  }, [permissions.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const beds = rooms.reduce((n, r) => n + r.totalBeds, 0);
  const busy = rooms.reduce((n, r) => n + r.occupiedBeds, 0);
  const space = rooms.reduce((n, r) => n + r.capacity - r.totalBeds, 0);
  const pct = beds ? Math.round(busy / beds * 100) : 0;
  const ring = 2 * Math.PI * 52;
  const f = extra.finance;
  const paidShare = f && Number(f.charged) > 0 ? Math.min(100, Math.round(Number(f.paid) / Number(f.charged) * 100)) : 0;
  const kpis: [string, ReactNode, string, number, string][] = [
    ['/rooms', <Building2 size={18} key="r" />, 'c-blue', rooms.length, 'Комнат'],
    ['/rooms', <BedDouble size={18} key="b" />, 'c-blue', beds, 'Всего мест'],
    ['/residents?filter=active', <Users size={18} key="u" />, 'c-red', busy, 'Занято'],
    ['/rooms', <CheckCircle2 size={18} key="c" />, 'c-green', beds - busy, 'Свободно'],
  ];
  if (f) kpis.push(['/finance', <AlertCircle size={18} key="d" />, 'c-orange', f.debtors, 'Должники']);
  if (extra.applications !== undefined) kpis.push(['/applications?status=SUBMITTED', <FileText size={18} key="a" />, 'c-violet', extra.applications, 'Новые заявки']);
  if (extra.tickets !== undefined) kpis.push(['/tickets', <MessageSquare size={18} key="t" />, 'c-blue', extra.tickets, 'Новые обращения']);
  kpis.push(['/rooms?filter=space', <Plus size={18} key="p" />, 'c-gray', space, 'Можно добавить']);

  return <div className="dashboard">
    <div className="page-heading hello"><div><div className="heading-kicker">{today().toUpperCase()}</div><h1>{greeting()}, {name.split(' ')[0]}!</h1><p>Вот что происходит в вашем доме сегодня.</p></div><div className="resident-actions">{actions}</div></div>
    <div className="stats-grid kpis">{kpis.map(([href, icon, tone, value, label]) => <Link href={href} className="stat kpi" key={label}><span className="kpi-row"><span className={`chip ${tone}`}>{icon}</span><strong>{value}</strong></span><small>{label}</small></Link>)}</div>
    <div className="dash-grid">
      <section className="card"><h2>Заполняемость дома</h2><div className="occupancy">
        <svg viewBox="0 0 130 130" role="img" aria-label={`Занято ${pct}%`}><circle cx="65" cy="65" r="52" className="ring-track" />{pct > 0 && <circle cx="65" cy="65" r="52" className="ring-value" strokeDasharray={`${ring * pct / 100} ${ring}`} transform="rotate(-90 65 65)" />}<text x="65" y="63" textAnchor="middle" className="ring-pct">{pct}%</text><text x="65" y="84" textAnchor="middle" className="ring-sub">{busy} из {beds}</text></svg>
        <div className="legend"><div><span className="sw busy" />Занято<b>{busy}</b></div><div><span className="sw free" />Свободно<b>{beds - busy}</b></div><div><span className="sw space" />Можно добавить<b>{space}</b></div></div>
      </div></section>
      {f ? <section className="card"><h2>Финансы <Link href="/finance">Подробнее</Link></h2><div className="money">
        <div><span className="chip c-blue"><FileText size={17} /></span><p><strong>{sum(f.charged)}</strong><small>Начислено</small></p></div>
        <div><span className="chip c-green"><CheckCircle2 size={17} /></span><p><strong>{sum(f.paid)}</strong><small>Оплачено</small></p></div>
        <div><span className="chip c-red"><AlertCircle size={17} /></span><p><strong>{sum(f.outstanding)}</strong><small>Долг{f.debtors ? ` · ${f.debtors} жильцов` : ''}</small></p></div>
        <div className="paid-bar" aria-label={`Оплачено ${paidShare}% начисленного`}><i style={{ width: `${paidShare}%` }} /></div><small>Оплачено {paidShare}% начисленного</small>
      </div></section> : <section className="card"><h2>Сегодня</h2><div className="money"><div><span className="chip c-green"><DoorOpen size={17} /></span><p><strong>{beds - busy} свободных мест</strong><small>Можно заселять</small></p></div></div></section>}
      <section className="card events-card"><h2>Последние события <Link href="/history">Все</Link></h2>{events}</section>
    </div>
    <section className="card"><h2>План дома <Link href="/rooms">Все комнаты</Link></h2>
      {rooms.length ? <div className="plan">{rooms.map(room => {
        const tone = room.totalBeds === 0 ? 'empty' : room.availableBeds === 0 ? 'full' : room.availableBeds <= Math.ceil(room.totalBeds / 4) ? 'almost' : 'free';
        return <Link href={`/rooms/${room.id}`} className={`room-card plan-tile ${tone}`} key={room.id}><h3>Комната №{room.number}</h3><b>{room.occupiedBeds}/{room.totalBeds}</b><small>{room.totalBeds === 0 ? 'Мест нет' : room.availableBeds ? `Свободно ${room.availableBeds}` : 'Мест нет'}</small></Link>;
      })}</div> : <div className="empty"><Building2 size={34} /><h3>Здесь появятся ваши комнаты</h3></div>}
      <p className="plan-legend"><span className="sw full" />Мест нет<span className="sw almost" />Почти заполнена<span className="sw free" />Есть места</p>
    </section>
  </div>;
}
