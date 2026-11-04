'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { BedDouble, CalendarClock, CheckCircle2, Clock, Percent, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';

type Month = { month: string; current: boolean; occupancyPct: number | null; bedsOccupied: number; beds: number; moveIns: number; moveOuts: number;
  charged: string; rentCharged: string; collected: string; received: string; collectionPct: number | null; onTimePct: number | null; dueCount: number; onTime: number; debt: string };
type Overview = {
  today: string; months: Month[];
  now: { beds: number; occupied: number; free: number; avgPrice: string; lostPerMonth: string;
    forecast: { month: string; rent: string; staying: number; leaving: number; leavingRent: string };
    endingIn30Days: { residents: number; rent: string }; avgStayDays: number | null; closedStays: number; avgTenureDays: number | null };
  window: { from: string; received: string; charged: string; collected: string; collectionPct: number | null; methods: { method: string; amount: string; count: number }[] };
  rooms: { id: string; number: string; beds: number; occupied: number; occupancyPct: number | null; received: string }[];
};

const sum = (v: string | number) => Math.round(Number(v)).toLocaleString('ru-RU') + ' сум';
const short = (v: string | number) => { const n = Number(v); return n >= 1e6 ? `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс` : String(Math.round(n)); };
const MONTHS3 = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const monthShort = (m: string) => MONTHS3[Number(m.slice(5, 7)) - 1];
const monthLong = (m: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${m}-01T00:00:00Z`)).replace(' г.', '');
const pct = (v: number | null) => v === null ? '—' : `${v.toLocaleString('ru-RU')}%`;
const stay = (days: number | null) => days === null ? '—' : days < 60 ? `${days} дн.` : `${(days / 30.4).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мес.`;
const methodRu: Record<string, string> = { CASH: 'Наличные', CARD_TRANSFER: 'Перевод на карту', BANK_TRANSFER: 'Банковский перевод', OTHER: 'Другое' };

/** Long series scroll sideways on phones; start at the latest month. */
const toEnd = (el: HTMLDivElement | null) => { if (el) el.scrollLeft = el.scrollWidth; };

/** One bar chart for a series of months; values are drawn against the largest one (or 100 for percents). */
function Bars({ label, months, value, text, max, tone = 'an-blue' }: { label: string; months: Month[]; value: (m: Month) => number | null; text: (m: Month) => string; max?: number; tone?: string }) {
  const peak = max ?? Math.max(1, ...months.map(m => value(m) ?? 0));
  return <div key={months.length} ref={toEnd} className="an-bars" role="img" aria-label={`${label}: ${months.map(m => `${monthShort(m.month)} ${text(m)}`).join(', ')}`}>
    {months.map(m => { const v = value(m); return <div key={m.month} title={`${monthLong(m.month)}: ${text(m)}`}>
      <span className="an-bar-value">{v === null || (v === 0 && !m.current) ? '' : text(m)}</span>
      <i className={`${tone} ${m.current ? 'an-now' : ''}`} style={{ height: `${!v ? 0 : Math.max(2, v / peak * 100)}%` }} />
      <small>{monthShort(m.month)}</small>
    </div>; })}
  </div>;
}

/** Charged and received side by side for each month. */
function Pairs({ months }: { months: Month[] }) {
  const peak = Math.max(1, ...months.flatMap(m => [Number(m.charged), Number(m.received)]));
  return <div key={months.length} ref={toEnd} className="an-bars an-pairs" role="img" aria-label={`Начислено и получено: ${months.map(m => `${monthShort(m.month)} начислено ${sum(m.charged)}, получено ${sum(m.received)}`).join('; ')}`}>
    {months.map(m => <div key={m.month} title={`${monthLong(m.month)}: начислено ${sum(m.charged)}, получено ${sum(m.received)}`}>
      <span className="an-bar-value">{Number(m.received) ? short(m.received) : ''}</span>
      <span className="an-pair"><i className="an-gray" style={{ height: `${Math.max(Number(m.charged) ? 2 : 0, Number(m.charged) / peak * 100)}%` }} /><i className={`an-green ${m.current ? 'an-now' : ''}`} style={{ height: `${Math.max(Number(m.received) ? 2 : 0, Number(m.received) / peak * 100)}%` }} /></span>
      <small>{monthShort(m.month)}</small>
    </div>)}
  </div>;
}

function Kpi({ icon, tone, value, label, hint }: { icon: ReactNode; tone: string; value: ReactNode; label: string; hint?: string }) {
  return <div className="stat kpi"><span className="kpi-row"><span className={`chip ${tone}`}>{icon}</span><strong>{value}</strong></span><small>{label}</small>{hint && <small className="an-hint">{hint}</small>}</div>;
}

/**
 * Owner analytics (roadmap 2026-10-31): how full the house is, how money comes in, whether rent is paid on
 * time, where debt is going, what next month brings and which rooms earn. Live on finance and house events.
 */
export function AnalyticsPanel() {
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState('');
  async function refresh() {
    try { setData(await api<Overview>(`/analytics?months=${months}`)); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, [months]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime(['finance', 'house'], refresh);

  const head = <div className="page-heading"><div><div className="eyebrow">Для владельца</div><h1>Аналитика</h1><p>Заполняемость, деньги и долги по месяцам. Обновляется сама при каждой оплате и заселении.</p></div>
    <div className="an-range" role="group" aria-label="Период">{[6, 12, 24].map(n => <button key={n} type="button" className={`button ${n === months ? 'primary' : 'secondary'}`} aria-pressed={n === months} onClick={() => setMonths(n)}>{n} мес.</button>)}</div></div>;
  if (error && !data) return <>{head}<div className="empty"><h3>Не удалось загрузить аналитику</h3><p>{error}</p><button type="button" className="button secondary" onClick={() => void refresh()}>Повторить</button></div></>;
  if (!data) return <>{head}<p className="an-loading">Загружаем…</p></>;

  const cur = data.months[data.months.length - 1], prev = data.months[data.months.length - 2];
  const trend = (a: number | null, b: number | null) => a === null || b === null || a === b ? null : a > b;
  const occTrend = trend(cur.occupancyPct, prev?.occupancyPct ?? null);
  const n = data.now, w = data.window;
  const methodTotal = Math.max(1, ...w.methods.map(x => Number(x.amount)));

  return <div className="an-page">
    {head}
    <div className="stats-grid an-kpis">
      <Kpi icon={<BedDouble size={18} />} tone="c-blue" value={pct(cur.occupancyPct)} label="Заполняемость в этом месяце"
        hint={occTrend === null ? `${n.occupied} из ${n.beds} мест занято` : `${occTrend ? '↑' : '↓'} было ${pct(prev.occupancyPct)} · ${n.occupied} из ${n.beds} мест`} />
      <Kpi icon={<Wallet size={18} />} tone="c-green" value={short(w.received)} label={`Получено за ${months} мес.`} hint={sum(w.received)} />
      <Kpi icon={<Percent size={18} />} tone="c-blue" value={pct(w.collectionPct)} label="Собрано от начисленного" hint={`${short(w.collected)} из ${short(w.charged)}`} />
      <Kpi icon={<Clock size={18} />} tone="c-orange" value={pct(cur.onTimePct ?? prev?.onTimePct ?? null)} label="Аренда оплачена в срок"
        hint={cur.dueCount ? `в этом месяце ${cur.onTime} из ${cur.dueCount}` : prev?.dueCount ? `в прошлом месяце ${prev.onTime} из ${prev.dueCount}` : 'пока нет сроков оплаты'} />
    </div>

    <div className="an-grid">
      <section className="card"><h2>Прогноз на {monthLong(n.forecast.month)}</h2>
        <p className="an-big">{sum(n.forecast.rent)}</p>
        <p className="an-note">Аренда от {n.forecast.staying} жильцов, которые остаются.{n.forecast.leaving > 0 && ` Минус ${n.forecast.leaving} выезжающих (${sum(n.forecast.leavingRent)}).`}</p>
        {n.endingIn30Days.residents > 0 && <p className="an-note an-warn"><CalendarClock size={15} /> В ближайшие 30 дней заканчивается проживание у {n.endingIn30Days.residents}: {sum(n.endingIn30Days.rent)} в месяц.</p>}
      </section>
      <section className="card"><h2>Свободные места</h2>
        <p className="an-big">{n.free} из {n.beds}</p>
        <p className="an-note">{n.free === 0 ? 'Все места заняты.' : Number(n.lostPerMonth) > 0 ? <>Недополучено примерно <b>{sum(n.lostPerMonth)}</b> в месяц при средней цене {sum(n.avgPrice)}.</> : 'Пока нет жильцов с ценой — недополученный доход посчитаем, когда появятся.'}</p>
      </section>
      <section className="card"><h2>Сколько живут</h2>
        <p className="an-big">{stay(n.avgTenureDays)}</p>
        <p className="an-note">Столько в среднем живут нынешние жильцы.{n.closedStays > 0 ? ` Выехавшие прожили в среднем ${stay(n.avgStayDays)} (${n.closedStays}).` : ' Выехавших пока нет.'}</p>
      </section>
    </div>

    <section className="card an-chart"><h2>Начислено и получено <span className="an-legend"><span><i className="an-gray" />Начислено</span><span><i className="an-green" />Получено</span></span></h2><Pairs months={data.months} /></section>
    <div className="an-grid an-two">
      <section className="card an-chart"><h2>Заполняемость</h2><Bars label="Заполняемость" months={data.months} value={m => m.occupancyPct} text={m => pct(m.occupancyPct)} max={100} /></section>
      <section className="card an-chart"><h2>Долг на конец месяца</h2><Bars label="Долг" months={data.months} value={m => Number(m.debt)} text={m => short(m.debt)} tone="an-red" /></section>
      <section className="card an-chart"><h2>Аренда в срок</h2><Bars label="Аренда в срок" months={data.months} value={m => m.onTimePct} text={m => pct(m.onTimePct)} max={100} tone="an-orange" /></section>
      <section className="card an-chart"><h2>Заезды и выезды</h2>
        <div key={data.months.length} ref={toEnd} className="an-moves">{data.months.map(m => <div key={m.month} title={`${monthLong(m.month)}: заехали ${m.moveIns}, выехали ${m.moveOuts}`}>
          <span className="an-in">{m.moveIns ? <><TrendingUp size={13} />{m.moveIns}</> : '·'}</span><span className="an-out">{m.moveOuts ? <><TrendingDown size={13} />{m.moveOuts}</> : '·'}</span><small>{monthShort(m.month)}</small>
        </div>)}</div>
      </section>
    </div>

    <div className="an-grid an-two">
      <section className="card"><h2>Комнаты за {months} мес.</h2>
        {data.rooms.length === 0 ? <p className="an-note">Комнат пока нет.</p> : <table className="an-table"><thead><tr><th>Комната</th><th>Занято</th><th>Заполняемость</th><th>Получено</th></tr></thead>
          <tbody>{data.rooms.map(r => <tr key={r.id}><td>№ {r.number}</td><td>{r.occupied} из {r.beds}</td><td><span className="an-meter"><i style={{ width: `${r.occupancyPct ?? 0}%` }} /></span>{pct(r.occupancyPct)}</td><td>{sum(r.received)}</td></tr>)}</tbody></table>}
      </section>
      <section className="card"><h2>Как платят</h2>
        {w.methods.length === 0 ? <p className="an-note">Оплат за период нет.</p> : w.methods.map(x => <div className="an-method" key={x.method}>
          <span>{methodRu[x.method] ?? x.method}<small>{x.count} опл.</small></span><span className="an-meter"><i style={{ width: `${Number(x.amount) / methodTotal * 100}%` }} /></span><b>{sum(x.amount)}</b>
        </div>)}
        <p className="an-note an-foot"><CheckCircle2 size={14} /> Месяцы — по ташкентскому времени. «В срок» — аренда, полностью оплаченная до дня оплаты с учётом отсрочки.</p>
      </section>
    </div>
  </div>;
}
